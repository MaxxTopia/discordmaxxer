// winaudio — WASAPI loopback capture for discordmaxxer.
//
// Two capture modes:
//
// 1. Per-output-device loopback (`startCapture(deviceId, ...)`) —
//    captures from a specific render endpoint. Useful when the user
//    has multiple output devices and wants to pick which one to share.
//
// 2. Per-process loopback (`startProcessLoopback(pid, mode, ...)`) —
//    captures audio FROM a specific app (or excluding it), regardless
//    of which output device the audio routes to. Solves the audio-
//    mixer echo problem: streamer's Voicemeeter routes Discord's
//    incoming voice into the captured output, viewers hear themselves.
//    Process loopback INCLUDE on a target like FortniteClient-Win64-
//    Shipping.exe captures pure game audio, no Discord involvement.
//    This is what the official Discord client does. Win10 1903+ only.
//
// Architecture:
//   - Single capture allowed at a time (Discord screenshares one stream).
//   - Capture thread does its own COM init (MTA), runs the WASAPI loop,
//     and emits PCM via Napi::ThreadSafeFunction.NonBlockingCall so the
//     audio thread is never blocked on the JS event loop.
//   - Per-device: returns the device's mix format (typically float32
//     stereo @ 48kHz on Win10/11).
//   - Per-process: format is fixed at float32 stereo @ 48kHz (the
//     Process Loopback API only accepts a small set of formats; this
//     is the highest-quality common option).
//   - Silence chunks (AUDCLNT_BUFFERFLAGS_SILENT) come through as zero-
//     length data + silent=true. Caller decides whether to render
//     silence or skip.

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX

#include <napi.h>

#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <audiopolicy.h>
#include <functiondiscoverykeys_devpkey.h>
#include <avrt.h>
#include <combaseapi.h>
#include <objbase.h>
#include <psapi.h>
#include <tlhelp32.h>

// VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK — Win10 1903+ virtual endpoint
// for Process Loopback. The header symbol exists in audioclientactivation
// params.h but only on recent SDKs; declare it inline so we compile on
// older toolchains too.
#ifndef VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK
#define VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK L"VAD\\Process_Loopback"
#endif

#include <atomic>
#include <chrono>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace {

// ─── Helpers ──────────────────────────────────────────────────────────

// COM smart-pointer-lite. Releases on destruction.
template <typename T>
struct ComPtr {
    T* p = nullptr;
    ComPtr() = default;
    explicit ComPtr(T* raw) : p(raw) {}
    ~ComPtr() { if (p) p->Release(); }
    ComPtr(const ComPtr&) = delete;
    ComPtr& operator=(const ComPtr&) = delete;
    ComPtr(ComPtr&& o) noexcept : p(o.p) { o.p = nullptr; }
    ComPtr& operator=(ComPtr&& o) noexcept { if (this != std::addressof(o)) { if (p) p->Release(); p = o.p; o.p = nullptr; } return *this; }
    T* operator->() const { return p; }
    T** operator&() { return &p; }
    explicit operator bool() const { return p != nullptr; }
    T* get() const { return p; }
    T* release() { T* r = p; p = nullptr; return r; }
    void reset(T* raw = nullptr) { if (p) p->Release(); p = raw; }
};

// CoTaskMemFree wrapper for LPWSTR / WAVEFORMATEX*.
struct CoTaskMemFreeDeleter { template <typename T> void operator()(T* p) const { if (p) CoTaskMemFree(p); } };

template <typename T>
using CoMemPtr = std::unique_ptr<T, CoTaskMemFreeDeleter>;

std::string utf16_to_utf8(const wchar_t* w) {
    if (!w) return {};
    int len = WideCharToMultiByte(CP_UTF8, 0, w, -1, nullptr, 0, nullptr, nullptr);
    if (len <= 1) return {};
    std::string out(static_cast<size_t>(len - 1), '\0');
    WideCharToMultiByte(CP_UTF8, 0, w, -1, out.data(), len, nullptr, nullptr);
    return out;
}

std::wstring utf8_to_utf16(const std::string& s) {
    if (s.empty()) return {};
    int len = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
    std::wstring out(static_cast<size_t>(len), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), out.data(), len);
    return out;
}

// Per-thread COM initialization scope guard.
struct ComScope {
    HRESULT hr;
    ComScope() { hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED); }
    ~ComScope() { if (SUCCEEDED(hr) && hr != RPC_E_CHANGED_MODE) CoUninitialize(); }
    bool ok() const { return SUCCEEDED(hr) || hr == RPC_E_CHANGED_MODE || hr == S_FALSE; }
};

// ─── Capture state (single-instance) ──────────────────────────────────

struct AudioChunkPayload {
    std::vector<uint8_t> data;
    uint32_t frameCount = 0;
    int64_t timestamp100ns = 0;
    bool silent = false;
};

struct CaptureState {
    std::atomic<bool> running{false};
    std::thread thread;
    std::wstring deviceId;
    Napi::ThreadSafeFunction tsfn;

    // Format echoed back to JS at startCapture time.
    uint32_t sampleRate = 0;
    uint16_t channels = 0;
    uint16_t bitsPerSample = 0;
    bool isFloat = false;
};

CaptureState g_capture;
std::mutex g_captureMutex; // serializes start/stop calls from JS thread

// Distinguishes the capture-thread main between per-device loopback and
// per-process loopback paths. Set before spawning the capture thread.
enum class CaptureMode { Device, ProcessInclude, ProcessExclude };
CaptureMode g_capture_mode = CaptureMode::Device;
uint32_t g_target_pid = 0;

// ─── Device enumeration ───────────────────────────────────────────────

Napi::Value ListOutputDevices(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    ComScope com;
    if (!com.ok()) {
        Napi::Error::New(env, "CoInitializeEx failed").ThrowAsJavaScriptException();
        return env.Null();
    }

    ComPtr<IMMDeviceEnumerator> enumerator;
    HRESULT hr = CoCreateInstance(
        __uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
        __uuidof(IMMDeviceEnumerator), reinterpret_cast<void**>(&enumerator));
    if (FAILED(hr)) {
        Napi::Error::New(env, "CoCreateInstance(MMDeviceEnumerator) failed: 0x" + std::to_string(hr)).ThrowAsJavaScriptException();
        return env.Null();
    }

    // Identify the default render device so we can mark it.
    std::wstring defaultId;
    {
        ComPtr<IMMDevice> defDev;
        if (SUCCEEDED(enumerator->GetDefaultAudioEndpoint(eRender, eMultimedia, &defDev))) {
            LPWSTR id = nullptr;
            if (SUCCEEDED(defDev->GetId(&id)) && id) {
                defaultId = id;
                CoTaskMemFree(id);
            }
        }
    }

    ComPtr<IMMDeviceCollection> coll;
    hr = enumerator->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &coll);
    if (FAILED(hr)) {
        Napi::Error::New(env, "EnumAudioEndpoints failed: 0x" + std::to_string(hr)).ThrowAsJavaScriptException();
        return env.Null();
    }

    UINT count = 0;
    coll->GetCount(&count);

    Napi::Array arr = Napi::Array::New(env, count);
    for (UINT i = 0; i < count; i++) {
        ComPtr<IMMDevice> dev;
        if (FAILED(coll->Item(i, &dev))) continue;

        LPWSTR rawId = nullptr;
        if (FAILED(dev->GetId(&rawId)) || !rawId) continue;
        std::wstring id(rawId);
        CoTaskMemFree(rawId);

        // Friendly name via property store.
        std::string friendly = "Unknown device";
        ComPtr<IPropertyStore> props;
        if (SUCCEEDED(dev->OpenPropertyStore(STGM_READ, &props))) {
            PROPVARIANT name;
            PropVariantInit(&name);
            if (SUCCEEDED(props->GetValue(PKEY_Device_FriendlyName, &name)) && name.vt == VT_LPWSTR) {
                friendly = utf16_to_utf8(name.pwszVal);
            }
            PropVariantClear(&name);
        }

        Napi::Object obj = Napi::Object::New(env);
        obj.Set("id", Napi::String::New(env, utf16_to_utf8(id.c_str())));
        obj.Set("name", Napi::String::New(env, friendly));
        obj.Set("isDefault", Napi::Boolean::New(env, !defaultId.empty() && id == defaultId));
        arr.Set(i, obj);
    }

    Napi::Object result = Napi::Object::New(env);
    result.Set("devices", arr);
    return result;
}

// ─── Audio session enumeration (for the per-process picker UI) ────────

struct SessionInfo {
    uint32_t pid;
    std::string process_name; // best-effort exe name; empty if access denied
    std::string display_name; // session display name, often empty
    bool is_active;
};

std::string pid_to_exe_name(uint32_t pid) {
    if (pid == 0) return std::string{}; // system idle
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, FALSE, pid);
    if (!h) {
        // Fall back to PROCESS_QUERY_LIMITED_INFORMATION only.
        h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if (!h) return std::string{};
    }
    wchar_t buf[MAX_PATH] = {0};
    DWORD len = MAX_PATH;
    std::string out;
    if (QueryFullProcessImageNameW(h, 0, buf, &len)) {
        std::wstring full(buf, len);
        size_t slash = full.find_last_of(L"\\/");
        std::wstring base = slash == std::wstring::npos ? full : full.substr(slash + 1);
        out = utf16_to_utf8(base.c_str());
    }
    CloseHandle(h);
    return out;
}

std::vector<SessionInfo> enumerate_sessions_impl() {
    std::vector<SessionInfo> out;
    ComPtr<IMMDeviceEnumerator> enumerator;
    HRESULT hr = CoCreateInstance(
        __uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
        __uuidof(IMMDeviceEnumerator), reinterpret_cast<void**>(&enumerator));
    if (FAILED(hr)) return out;

    // Iterate ALL active render endpoints — apps using a non-default device
    // (e.g., Discord on eCommunications, a game on a specific headset) won't
    // show up if we only query the default. Also iterate inactive states so
    // recently-closed apps still appear briefly (they fall off on their own).
    ComPtr<IMMDeviceCollection> devices;
    if (FAILED(enumerator->EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE, &devices))) {
        return out;
    }
    UINT device_count = 0;
    devices->GetCount(&device_count);

    for (UINT d = 0; d < device_count; d++) {
        ComPtr<IMMDevice> device;
        if (FAILED(devices->Item(d, &device))) continue;

        ComPtr<IAudioSessionManager2> sessionMgr;
        if (FAILED(device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr,
                                    reinterpret_cast<void**>(&sessionMgr)))) {
            continue;
        }
        ComPtr<IAudioSessionEnumerator> sessions;
        if (FAILED(sessionMgr->GetSessionEnumerator(&sessions))) continue;

        int count = 0;
        sessions->GetCount(&count);
        for (int i = 0; i < count; i++) {
            ComPtr<IAudioSessionControl> ctrl;
            if (FAILED(sessions->GetSession(i, &ctrl))) continue;
            ComPtr<IAudioSessionControl2> ctrl2;
            if (FAILED(ctrl->QueryInterface(__uuidof(IAudioSessionControl2),
                                            reinterpret_cast<void**>(&ctrl2)))) continue;

            DWORD pid = 0;
            if (FAILED(ctrl2->GetProcessId(&pid))) continue;
            if (pid == 0) continue; // system sounds session — can't target

            SessionInfo info;
            info.pid = pid;
            info.process_name = pid_to_exe_name(pid);
            LPWSTR raw_name = nullptr;
            if (SUCCEEDED(ctrl->GetDisplayName(&raw_name)) && raw_name) {
                info.display_name = utf16_to_utf8(raw_name);
                CoTaskMemFree(raw_name);
            }
            AudioSessionState state = AudioSessionStateInactive;
            ctrl->GetState(&state);
            info.is_active = (state == AudioSessionStateActive);
            out.push_back(std::move(info));
        }
    }
    return out;
}

Napi::Value EnumerateAudioSessions(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    ComScope com;
    if (!com.ok()) {
        Napi::Error::New(env, "CoInitializeEx failed").ThrowAsJavaScriptException();
        return env.Null();
    }
    auto sessions = enumerate_sessions_impl();

    // Dedup by pid: a process can have multiple audio sessions (one per
    // stream); for the UI we want one row per process.
    std::vector<SessionInfo> dedup;
    std::vector<uint32_t> seen;
    for (const auto& s : sessions) {
        bool found = false;
        for (auto pid : seen) if (pid == s.pid) { found = true; break; }
        if (found) continue;
        seen.push_back(s.pid);
        dedup.push_back(s);
    }

    Napi::Array arr = Napi::Array::New(env, dedup.size());
    for (size_t i = 0; i < dedup.size(); i++) {
        const auto& s = dedup[i];
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("pid", Napi::Number::New(env, s.pid));
        obj.Set("processName", Napi::String::New(env, s.process_name));
        obj.Set("displayName", Napi::String::New(env, s.display_name));
        obj.Set("isActive", Napi::Boolean::New(env, s.is_active));
        arr.Set(i, obj);
    }
    Napi::Object result = Napi::Object::New(env);
    result.Set("sessions", arr);
    return result;
}

// ─── Process Loopback (Win10 1903+) ───────────────────────────────────
//
// ActivateAudioInterfaceAsync dispatches to a worker thread + signals
// completion via this handler. We block the calling thread on an event
// to keep the API synchronous from JS's perspective.

class ProcessLoopbackActivationHandler : public IActivateAudioInterfaceCompletionHandler {
public:
    HANDLE event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    HRESULT activation_hr = E_PENDING;
    ComPtr<IAudioClient> client;

    ~ProcessLoopbackActivationHandler() {
        if (event) CloseHandle(event);
    }

    // IUnknown
    STDMETHODIMP_(ULONG) AddRef() override { return 1; }
    STDMETHODIMP_(ULONG) Release() override { return 1; }
    STDMETHODIMP QueryInterface(REFIID riid, void** ppv) override {
        if (!ppv) return E_POINTER;
        // IAgileObject is REQUIRED: ActivateAudioInterfaceAsync marshals this
        // handler across apartments and rejects the whole call with
        // E_ILLEGAL_METHOD_CALL (0x8000000E) if the handler isn't agile. It's a
        // marker interface (no methods), so returning ourselves is sufficient.
        if (riid == __uuidof(IUnknown) ||
            riid == __uuidof(IActivateAudioInterfaceCompletionHandler) ||
            riid == __uuidof(IAgileObject)) {
            *ppv = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }
    STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation* op) override {
        HRESULT hr_act = E_UNEXPECTED;
        IUnknown* punk = nullptr;
        HRESULT hr = op->GetActivateResult(&hr_act, &punk);
        if (SUCCEEDED(hr) && SUCCEEDED(hr_act) && punk) {
            IAudioClient* ac = nullptr;
            if (SUCCEEDED(punk->QueryInterface(__uuidof(IAudioClient),
                                               reinterpret_cast<void**>(&ac)))) {
                client.reset(ac);
            }
            punk->Release();
            activation_hr = S_OK;
        } else {
            activation_hr = SUCCEEDED(hr_act) ? hr : hr_act;
        }
        SetEvent(event);
        return S_OK;
    }
};

// Activate IAudioClient for process loopback. Caller passes the target
// process tree root + mode. Format is fixed to float32 stereo @ 48kHz
// (what Windows accepts for process loopback + matches our renderer
// AudioWorklet format).
HRESULT activate_process_loopback(
    uint32_t target_pid,
    PROCESS_LOOPBACK_MODE mode,
    ComPtr<IAudioClient>& out_client,
    WAVEFORMATEX& out_format)
{
    AUDIOCLIENT_ACTIVATION_PARAMS params{};
    params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId = target_pid;
    params.ProcessLoopbackParams.ProcessLoopbackMode = mode;

    PROPVARIANT activate_params{};
    activate_params.vt = VT_BLOB;
    activate_params.blob.cbSize = sizeof(params);
    activate_params.blob.pBlobData = reinterpret_cast<BYTE*>(&params);

    ProcessLoopbackActivationHandler handler;
    if (!handler.event) return E_OUTOFMEMORY;

    IActivateAudioInterfaceAsyncOperation* asyncOp = nullptr;
    HRESULT hr = ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        __uuidof(IAudioClient),
        &activate_params,
        &handler,
        &asyncOp);
    if (FAILED(hr)) return hr;

    // Wait up to 5s for the async activation to complete.
    DWORD wait = WaitForSingleObject(handler.event, 5000);
    if (asyncOp) asyncOp->Release();
    if (wait != WAIT_OBJECT_0) return E_FAIL;
    if (FAILED(handler.activation_hr)) return handler.activation_hr;
    if (!handler.client) return E_FAIL;

    // Process Loopback requires a fixed format. Use float32 stereo @ 48kHz —
    // matches what our renderer AudioWorklet expects.
    out_format = {};
    out_format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
    out_format.nChannels = 2;
    out_format.nSamplesPerSec = 48000;
    out_format.wBitsPerSample = 32;
    out_format.nBlockAlign = (out_format.nChannels * out_format.wBitsPerSample) / 8;
    out_format.nAvgBytesPerSec = out_format.nSamplesPerSec * out_format.nBlockAlign;

    hr = handler.client->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
        20 * 10000, // 20ms in 100ns
        AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
        &out_format,
        nullptr);
    if (FAILED(hr)) return hr;

    out_client = std::move(handler.client);
    return S_OK;
}

// ─── Capture thread ───────────────────────────────────────────────────

// Each PCM packet flows: capture thread → TSFN.NonBlockingCall(lambda) →
// JS thread → lambda runs in JS context → builds JS chunk → invokes user
// callback. We use the lambda overload (not the typed-data overload) so
// we don't have to wrestle with the templated Finalizer signatures.

void CaptureThreadMain() {
    ComScope com;
    if (!com.ok()) return;

    // Boost thread priority — we're on the audio path. AvSetMmThread tags
    // us as "Audio" class so the scheduler prefers us over normal work.
    DWORD taskIndex = 0;
    HANDLE mmcssHandle = AvSetMmThreadCharacteristicsW(L"Audio", &taskIndex);

    auto cleanup = [&]() {
        if (mmcssHandle) AvRevertMmThreadCharacteristics(mmcssHandle);
    };

    ComPtr<IAudioClient> client;
    WAVEFORMATEX mixFormatStorage{};
    WAVEFORMATEX* mixFormatPtr = nullptr;
    CoMemPtr<WAVEFORMATEX> mixFormatOwned;

    HRESULT hr;
    if (g_capture_mode == CaptureMode::Device) {
        ComPtr<IMMDeviceEnumerator> enumerator;
        hr = CoCreateInstance(
            __uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
            __uuidof(IMMDeviceEnumerator), reinterpret_cast<void**>(&enumerator));
        if (FAILED(hr)) { cleanup(); return; }

        ComPtr<IMMDevice> device;
        hr = enumerator->GetDevice(g_capture.deviceId.c_str(), &device);
        if (FAILED(hr)) { cleanup(); return; }

        hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                              reinterpret_cast<void**>(&client));
        if (FAILED(hr)) { cleanup(); return; }

        WAVEFORMATEX* mixFormatRaw = nullptr;
        hr = client->GetMixFormat(&mixFormatRaw);
        if (FAILED(hr) || !mixFormatRaw) { cleanup(); return; }
        mixFormatOwned.reset(mixFormatRaw);
        mixFormatPtr = mixFormatOwned.get();

        hr = client->Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
            200000, // 20 ms in 100-ns units
            0,
            mixFormatPtr,
            nullptr);
        if (FAILED(hr)) { cleanup(); return; }
    } else {
        // Process loopback path — Win10 1903+. activate_process_loopback
        // handles the async ActivateAudioInterfaceAsync + Initialize
        // dance and returns a fully-initialized IAudioClient.
        PROCESS_LOOPBACK_MODE mode = g_capture_mode == CaptureMode::ProcessInclude
            ? PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
            : PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;
        hr = activate_process_loopback(g_target_pid, mode, client, mixFormatStorage);
        if (FAILED(hr) || !client) { cleanup(); return; }
        mixFormatPtr = &mixFormatStorage;
    }

    g_capture.sampleRate = mixFormatPtr->nSamplesPerSec;
    g_capture.channels = mixFormatPtr->nChannels;
    g_capture.bitsPerSample = mixFormatPtr->wBitsPerSample;
    g_capture.isFloat = false;
    if (mixFormatPtr->wFormatTag == WAVE_FORMAT_IEEE_FLOAT) {
        g_capture.isFloat = true;
    } else if (mixFormatPtr->wFormatTag == WAVE_FORMAT_EXTENSIBLE) {
        auto* ext = reinterpret_cast<WAVEFORMATEXTENSIBLE*>(mixFormatPtr);
        if (ext->SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT) g_capture.isFloat = true;
    }

    HANDLE eventHandle = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    if (!eventHandle) { cleanup(); return; }

    hr = client->SetEventHandle(eventHandle);
    if (FAILED(hr)) { CloseHandle(eventHandle); cleanup(); return; }

    ComPtr<IAudioCaptureClient> capture;
    hr = client->GetService(__uuidof(IAudioCaptureClient),
                            reinterpret_cast<void**>(&capture));
    if (FAILED(hr)) { CloseHandle(eventHandle); cleanup(); return; }

    hr = client->Start();
    if (FAILED(hr)) { CloseHandle(eventHandle); cleanup(); return; }

    const uint32_t frameSize = mixFormatPtr->nBlockAlign;

    while (g_capture.running.load(std::memory_order_acquire)) {
        DWORD wait = WaitForSingleObject(eventHandle, 200); // 200ms tick
        if (wait == WAIT_TIMEOUT) continue;
        if (wait != WAIT_OBJECT_0) break;

        // Drain everything available this tick.
        UINT32 packetFrames = 0;
        while (SUCCEEDED(capture->GetNextPacketSize(&packetFrames)) && packetFrames > 0) {
            BYTE* dataPtr = nullptr;
            UINT32 framesRead = 0;
            DWORD flags = 0;
            UINT64 devicePosition = 0;
            UINT64 qpcPosition = 0;
            hr = capture->GetBuffer(&dataPtr, &framesRead, &flags,
                                    &devicePosition, &qpcPosition);
            if (FAILED(hr)) break;

            const bool silent = (flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0;

            // Build the payload + queue a lambda that runs on the JS thread
            // to convert it into a JS object and invoke the user callback.
            auto payload = std::make_shared<AudioChunkPayload>();
            payload->frameCount = framesRead;
            payload->timestamp100ns = static_cast<int64_t>(qpcPosition);
            payload->silent = silent;
            if (!silent && framesRead > 0 && dataPtr) {
                size_t bytes = static_cast<size_t>(framesRead) * frameSize;
                payload->data.assign(dataPtr, dataPtr + bytes);
            }

            capture->ReleaseBuffer(framesRead);

            napi_status status = g_capture.tsfn.NonBlockingCall(
                [payload](Napi::Env env, Napi::Function jsCallback) {
                    // Hand off PCM bytes to a Buffer with a finalizer that
                    // releases our heap vector on GC. Keeps it zero-copy.
                    auto* heap = new std::vector<uint8_t>(std::move(payload->data));
                    Napi::Buffer<uint8_t> buf = Napi::Buffer<uint8_t>::New(
                        env, heap->data(), heap->size(),
                        [](Napi::Env, uint8_t*, std::vector<uint8_t>* v) { delete v; },
                        heap);

                    Napi::Object chunk = Napi::Object::New(env);
                    chunk.Set("data", buf);
                    chunk.Set("frameCount", Napi::Number::New(env, payload->frameCount));
                    chunk.Set("timestamp100ns", Napi::BigInt::New(env, payload->timestamp100ns));
                    chunk.Set("silent", Napi::Boolean::New(env, payload->silent));

                    jsCallback.Call({ chunk });
                });
            if (status != napi_ok) {
                // JS side closed the queue or it's full — bail; capture
                // packets dropped on the floor when JS can't keep up.
                g_capture.running.store(false, std::memory_order_release);
                break;
            }
        }
    }

    client->Stop();
    CloseHandle(eventHandle);
    cleanup();
}

// ─── JS-facing entry points ───────────────────────────────────────────

Napi::Value StartCapture(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsFunction()) {
        Napi::TypeError::New(env, "startCapture(deviceId: string, onChunk: (chunk) => void)").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::lock_guard<std::mutex> lock(g_captureMutex);
    if (g_capture.running.load()) {
        Napi::Error::New(env, "another capture is already active — stopCapture() first").ThrowAsJavaScriptException();
        return env.Null();
    }

    std::string deviceIdUtf8 = info[0].As<Napi::String>().Utf8Value();
    Napi::Function cb = info[1].As<Napi::Function>();

    g_capture_mode = CaptureMode::Device;
    g_capture.deviceId = utf8_to_utf16(deviceIdUtf8);

    // Probe the device's mix format synchronously so we can return the
    // CaptureFormat to JS before launching the capture thread. The thread
    // then re-acquires + caches everything for the actual capture.
    {
        ComScope com;
        if (!com.ok()) {
            Napi::Error::New(env, "CoInitializeEx failed").ThrowAsJavaScriptException();
            return env.Null();
        }
        ComPtr<IMMDeviceEnumerator> enumerator;
        HRESULT hr = CoCreateInstance(
            __uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
            __uuidof(IMMDeviceEnumerator), reinterpret_cast<void**>(&enumerator));
        if (FAILED(hr)) {
            Napi::Error::New(env, "MMDeviceEnumerator unavailable").ThrowAsJavaScriptException();
            return env.Null();
        }
        ComPtr<IMMDevice> dev;
        hr = enumerator->GetDevice(g_capture.deviceId.c_str(), &dev);
        if (FAILED(hr)) {
            Napi::Error::New(env, "device not found: " + deviceIdUtf8).ThrowAsJavaScriptException();
            return env.Null();
        }
        ComPtr<IAudioClient> client;
        hr = dev->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr,
                           reinterpret_cast<void**>(&client));
        if (FAILED(hr)) {
            Napi::Error::New(env, "IAudioClient activation failed").ThrowAsJavaScriptException();
            return env.Null();
        }
        WAVEFORMATEX* fmtRaw = nullptr;
        hr = client->GetMixFormat(&fmtRaw);
        if (FAILED(hr) || !fmtRaw) {
            Napi::Error::New(env, "GetMixFormat failed").ThrowAsJavaScriptException();
            return env.Null();
        }
        CoMemPtr<WAVEFORMATEX> fmt(fmtRaw);
        g_capture.sampleRate = fmt->nSamplesPerSec;
        g_capture.channels = fmt->nChannels;
        g_capture.bitsPerSample = fmt->wBitsPerSample;
        g_capture.isFloat = false;
        if (fmt->wFormatTag == WAVE_FORMAT_IEEE_FLOAT) {
            g_capture.isFloat = true;
        } else if (fmt->wFormatTag == WAVE_FORMAT_EXTENSIBLE) {
            auto* ext = reinterpret_cast<WAVEFORMATEXTENSIBLE*>(fmt.get());
            if (ext->SubFormat == KSDATAFORMAT_SUBTYPE_IEEE_FLOAT) g_capture.isFloat = true;
        }
    }

    // Build the format object NOW so the JS caller has it on resolution.
    Napi::Object format = Napi::Object::New(env);
    format.Set("sampleRate", Napi::Number::New(env, g_capture.sampleRate));
    format.Set("channels", Napi::Number::New(env, g_capture.channels));
    format.Set("bitsPerSample", Napi::Number::New(env, g_capture.bitsPerSample));
    format.Set("isFloat", Napi::Boolean::New(env, g_capture.isFloat));

    // Wire the thread-safe function. Queue is bounded — when the JS event
    // loop falls behind, NonBlockingCall returns napi_queue_full and the
    // capture thread drops the packet (better than back-pressure killing
    // the audio thread).
    g_capture.tsfn = Napi::ThreadSafeFunction::New(
        env,
        cb,
        "winaudio.capture",
        /*maxQueueSize*/ 64,
        /*initialThreadCount*/ 1);

    g_capture.running.store(true, std::memory_order_release);
    g_capture.thread = std::thread([] {
        CaptureThreadMain();
        // When the loop exits (stop was requested OR fatal error), release
        // our hold on the TSFN so JS-side resources can be GC'd.
        g_capture.tsfn.Release();
    });

    return format;
}

Napi::Value StartProcessLoopback(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsString() || !info[2].IsFunction()) {
        Napi::TypeError::New(env,
            "startProcessLoopback(targetPid: number, mode: 'include' | 'exclude', onChunk: (chunk) => void)")
            .ThrowAsJavaScriptException();
        return env.Null();
    }

    std::lock_guard<std::mutex> lock(g_captureMutex);
    if (g_capture.running.load()) {
        Napi::Error::New(env, "another capture is already active — stopCapture() first").ThrowAsJavaScriptException();
        return env.Null();
    }

    uint32_t pid = info[0].As<Napi::Number>().Uint32Value();
    std::string mode_str = info[1].As<Napi::String>().Utf8Value();
    Napi::Function cb = info[2].As<Napi::Function>();

    if (mode_str != "include" && mode_str != "exclude") {
        Napi::TypeError::New(env, "mode must be 'include' or 'exclude'").ThrowAsJavaScriptException();
        return env.Null();
    }
    g_capture_mode = (mode_str == "include")
        ? CaptureMode::ProcessInclude
        : CaptureMode::ProcessExclude;
    g_target_pid = pid;
    g_capture.deviceId.clear();

    // Format is fixed for process loopback (matches activate_process_loopback).
    g_capture.sampleRate = 48000;
    g_capture.channels = 2;
    g_capture.bitsPerSample = 32;
    g_capture.isFloat = true;

    Napi::Object format = Napi::Object::New(env);
    format.Set("sampleRate", Napi::Number::New(env, g_capture.sampleRate));
    format.Set("channels", Napi::Number::New(env, g_capture.channels));
    format.Set("bitsPerSample", Napi::Number::New(env, g_capture.bitsPerSample));
    format.Set("isFloat", Napi::Boolean::New(env, g_capture.isFloat));

    g_capture.tsfn = Napi::ThreadSafeFunction::New(
        env, cb, "winaudio.process-loopback", 64, 1);

    g_capture.running.store(true, std::memory_order_release);
    g_capture.thread = std::thread([] {
        CaptureThreadMain();
        g_capture.tsfn.Release();
    });

    return format;
}

Napi::Value StopCapture(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    std::lock_guard<std::mutex> lock(g_captureMutex);
    if (!g_capture.running.load()) return env.Undefined();

    g_capture.running.store(false, std::memory_order_release);
    if (g_capture.thread.joinable()) g_capture.thread.join();

    return env.Undefined();
}

Napi::Value IsCapturing(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), g_capture.running.load());
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("listOutputDevices", Napi::Function::New(env, ListOutputDevices));
    exports.Set("startCapture", Napi::Function::New(env, StartCapture));
    exports.Set("stopCapture", Napi::Function::New(env, StopCapture));
    exports.Set("isCapturing", Napi::Function::New(env, IsCapturing));
    exports.Set("enumerateAudioSessions", Napi::Function::New(env, EnumerateAudioSessions));
    exports.Set("startProcessLoopback", Napi::Function::New(env, StartProcessLoopback));
    return exports;
}

} // namespace

NODE_API_MODULE(winaudio, Init)
