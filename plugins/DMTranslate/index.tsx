/*
 * Discordmaxxer — DMTranslate plugin
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Standalone message translation. Right-click a message and choose Translate;
 * automatically detects any source language (Japanese, Spanish, Russian, Chinese,
 * etc.) and translates it to English (or chosen target language) with multi-engine
 * resilience (Google Translate, Google PA, MyMemory, and DeepL).
 */

import "./styles.css";

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { copyWithToast } from "@utils/discord";
import { ModalCloseButton, ModalContent, ModalHeader, ModalRoot, ModalSize } from "@utils/modal";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { Message, RenderModalProps } from "@vencord/discord-types";

const getNative = () => (typeof VencordNative !== "undefined" ? VencordNative?.pluginHelpers?.DMTranslate : undefined) as PluginNative<typeof import("./native")> | undefined;
import {
    Button,
    Forms,
    Menu,
    openModal,
    Toasts,
    useEffect,
    useState
} from "@webpack/common";

const GOOGLE_TRANSLATE_KEY = "AIzaSyDLEeFI5OtFBwYBIoK_jj5m32rZK5CkCXA";
const MAX_MESSAGE_LENGTH = 5000;

// Legacy modal aliases from @utils/modal
const LegacyModalRoot: any = ModalRoot;
const LegacyModalHeader: any = ModalHeader;
const LegacyModalContent: any = ModalContent;
const LegacyModalCloseButton: any = ModalCloseButton;

const LANGUAGE_OPTIONS = [
    { label: "English", value: "en", default: true },
    { label: "Spanish", value: "es" },
    { label: "French", value: "fr" },
    { label: "German", value: "de" },
    { label: "Japanese", value: "ja" },
    { label: "Korean", value: "ko" },
    { label: "Portuguese", value: "pt" },
    { label: "Chinese (Simplified)", value: "zh-CN" },
    { label: "Chinese (Traditional)", value: "zh-TW" },
    { label: "Russian", value: "ru" },
    { label: "Italian", value: "it" },
    { label: "Arabic", value: "ar" },
    { label: "Hindi", value: "hi" },
    { label: "Dutch", value: "nl" },
    { label: "Polish", value: "pl" },
    { label: "Swedish", value: "sv" },
    { label: "Turkish", value: "tr" },
    { label: "Ukrainian", value: "uk" },
    { label: "Vietnamese", value: "vi" }
] as const;

const LANGUAGE_NAMES: Record<string, string> = {
    ja: "Japanese",
    en: "English",
    es: "Spanish",
    fr: "French",
    de: "German",
    zh: "Chinese",
    "zh-cn": "Chinese (Simplified)",
    "zh-tw": "Chinese (Traditional)",
    ko: "Korean",
    ru: "Russian",
    it: "Italian",
    pt: "Portuguese",
    ar: "Arabic",
    hi: "Hindi",
    nl: "Dutch",
    pl: "Polish",
    sv: "Swedish",
    tr: "Turkish",
    uk: "Ukrainian",
    vi: "Vietnamese",
    th: "Thai",
    id: "Indonesian",
    el: "Greek",
    he: "Hebrew",
    iw: "Hebrew",
    cs: "Czech",
    ro: "Romanian",
    hu: "Hungarian",
    da: "Danish",
    fi: "Finnish",
    no: "Norwegian",
    tl: "Tagalog",
    auto: "Auto-detected"
};

type LanguageCode = (typeof LANGUAGE_OPTIONS)[number]["value"];

function languageLabel(code: string): string {
    if (!code) return "Detected Language";
    const clean = code.trim().toLowerCase();
    return (
        LANGUAGE_NAMES[code] ||
        LANGUAGE_NAMES[clean] ||
        LANGUAGE_OPTIONS.find(option => option.value.toLowerCase() === clean)?.label ||
        code
    );
}

const settings = definePluginSettings({
    targetLanguage: {
        type: OptionType.SELECT,
        description: "Language used when you choose Translate from a message's right-click menu.",
        default: "en" as LanguageCode,
        options: LANGUAGE_OPTIONS
    },
    service: {
        type: OptionType.SELECT,
        description: "Primary translation service",
        default: "google",
        options: [
            { label: "Google Translate (Auto-detect, Free)", value: "google", default: true },
            { label: "DeepL (Requires API Key)", value: "deepl" }
        ]
    },
    deeplApiKey: {
        type: OptionType.STRING,
        description: "DeepL API authentication key (optional, used if DeepL service is selected)",
        default: ""
    }
});

function TranslateIcon({ width = 20, height = 20, className }: { width?: number; height?: number; className?: string; }) {
    return (
        <svg width={width} height={height} className={className} viewBox="0 0 24 24" aria-hidden="true">
            <path
                fill="currentColor"
                d="M12 2a10 10 0 100 20 10 10 0 000-20zm6.93 6H15.9a15.6 15.6 0 00-1.38-3.56A8.03 8.03 0 0118.93 8zM12 4.04c.83 1.2 1.48 2.53 1.91 3.96h-3.82c.43-1.43 1.08-2.76 1.91-3.96zM4.26 14a7.82 7.82 0 010-4h3.38a16.5 16.5 0 000 4H4.26zm.81 2h3.03c.34 1.28.8 2.5 1.38 3.56A7.99 7.99 0 015.07 16zm3.03-8H5.07a7.99 7.99 0 014.41-3.56A15.6 15.6 0 008.1 8zM12 19.96c-.83-1.2-1.48-2.53-1.91-3.96h3.82A13.7 13.7 0 0112 19.96zM14.34 14H9.66a14.9 14.9 0 010-4h4.68a14.9 14.9 0 010 4zm.25 5.56c.58-1.06 1.04-2.28 1.38-3.56h3.03a7.99 7.99 0 01-4.41 3.56zM16.36 14a16.5 16.5 0 000-4h3.38a7.82 7.82 0 010 4h-3.38z"
            />
        </svg>
    );
}

interface TranslationResult {
    translation: string;
    sourceLanguage: string;
    engine: string;
}

function getMessageContent(message: Message): string {
    return (
        message.content ||
        message.messageSnapshots?.[0]?.message.content ||
        message.embeds?.find(embed => embed.type === "auto_moderation_message")?.rawDescription ||
        message.embeds?.[0]?.description ||
        ""
    );
}

// Engine 1: Google Translate single endpoint (no credentials, auto-detects, high reliability)
async function translateViaGoogleSingle(text: string, targetLang: string): Promise<TranslationResult> {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text.slice(0, MAX_MESSAGE_LENGTH))}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Google Translate HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error("Invalid Google response");
    const translation = data[0].map((chunk: any) => chunk?.[0] ?? "").join("").trim();
    if (!translation) throw new Error("Empty Google translation");
    const sourceLanguage = typeof data[2] === "string" ? data[2] : "auto";
    return { translation, sourceLanguage, engine: "Google Translate" };
}

// Engine 2: Google Translate PA endpoint (fallback Google pipeline)
async function translateViaGooglePA(text: string, targetLang: string): Promise<TranslationResult> {
    const url =
        "https://translate-pa.googleapis.com/v1/translate?" +
        new URLSearchParams({
            "params.client": "gtx",
            dataTypes: "TRANSLATION",
            key: GOOGLE_TRANSLATE_KEY,
            "query.sourceLanguage": "auto",
            "query.targetLanguage": targetLang,
            "query.text": text.slice(0, MAX_MESSAGE_LENGTH)
        });
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Google PA HTTP ${res.status}`);
    const data = await res.json();
    if (!data.translation?.trim()) throw new Error("Empty Google PA translation");
    return {
        translation: data.translation.trim(),
        sourceLanguage: data.sourceLanguage || "auto",
        engine: "Google Translate"
    };
}

// Engine 3: MyMemory endpoint (tertiary fallback)
async function translateViaMyMemory(text: string, targetLang: string): Promise<TranslationResult> {
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.slice(0, 500))}&langpair=autodetect|${encodeURIComponent(targetLang)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`MyMemory HTTP ${res.status}`);
    const data = await res.json();
    const translation = data.responseData?.translatedText?.trim();
    if (!translation || translation.startsWith("MYMEMORY WARNING")) throw new Error("Invalid MyMemory translation");
    const sourceLanguage = data.responseData?.detectedLanguage || "auto";
    return { translation, sourceLanguage, engine: "MyMemory" };
}

// Engine 4: DeepL (optional, if user provides authentication key in settings)
async function translateViaDeepL(text: string, targetLang: string, apiKey: string): Promise<TranslationResult> {
    const url = apiKey.endsWith(":fx")
        ? "https://api-free.deepl.com/v2/translate"
        : "https://api.deepl.com/v2/translate";
    const res = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `DeepL-Auth-Key ${apiKey}`
        },
        body: JSON.stringify({
            text: [text.slice(0, MAX_MESSAGE_LENGTH)],
            target_lang: targetLang.toUpperCase()
        })
    });
    if (!res.ok) throw new Error(`DeepL HTTP ${res.status}`);
    const data = await res.json();
    const translation = data.translations?.[0]?.text?.trim();
    if (!translation) throw new Error("Empty DeepL translation");
    const sourceLanguage = (data.translations?.[0]?.detected_source_language || "auto").toLowerCase();
    return { translation, sourceLanguage, engine: "DeepL" };
}

async function translateText(text: string): Promise<TranslationResult> {
    const Native = getNative();
    const targetLang = (settings.store.targetLanguage as string) || "en";
    const deeplKey = (settings.store.deeplApiKey as string)?.trim();

    // 1. DeepL if user selected it and provided API key
    if (settings.store.service === "deepl" && deeplKey) {
        try {
            if (Native?.translateViaDeepL) {
                const res = await Native.translateViaDeepL(text, targetLang, deeplKey);
                if (res.ok && res.translation) {
                    return { translation: res.translation, sourceLanguage: res.sourceLanguage || "auto", engine: "DeepL" };
                }
            } else {
                return await translateViaDeepL(text, targetLang, deeplKey);
            }
        } catch (err) {
            console.warn("[DMTranslate] DeepL failed, falling back to Google Translate:", err);
        }
    }

    // 2. Primary: Google Single Translate (auto-detect, free, fastest)
    try {
        if (Native?.translateViaGoogleSingle) {
            const res = await Native.translateViaGoogleSingle(text, targetLang);
            if (res.ok && res.translation) {
                return { translation: res.translation, sourceLanguage: res.sourceLanguage || "auto", engine: "Google Translate" };
            }
        } else {
            return await translateViaGoogleSingle(text, targetLang);
        }
    } catch (err) {
        console.warn("[DMTranslate] Google Single failed, trying Google PA:", err);
    }

    // 3. Secondary: Google PA Translate (Google Translate endpoint 2)
    try {
        if (Native?.translateViaGooglePA) {
            const res = await Native.translateViaGooglePA(text, targetLang);
            if (res.ok && res.translation) {
                return { translation: res.translation, sourceLanguage: res.sourceLanguage || "auto", engine: "Google Translate" };
            }
        } else {
            return await translateViaGooglePA(text, targetLang);
        }
    } catch (err) {
        console.warn("[DMTranslate] Google PA failed, trying MyMemory:", err);
    }

    // 4. Tertiary: MyMemory fallback
    if (Native?.translateViaMyMemory) {
        const res = await Native.translateViaMyMemory(text, targetLang);
        if (res.ok && res.translation) {
            return { translation: res.translation, sourceLanguage: res.sourceLanguage || "auto", engine: "MyMemory" };
        }
    }
    return await translateViaMyMemory(text, targetLang);
}

function SafeModalContainer({
    transitionState,
    onClose,
    title,
    children
}: {
    transitionState?: any;
    onClose: () => void;
    title: string;
    children: React.ReactNode;
}) {
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.stopPropagation();
                onClose();
            }
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [onClose]);

    if (LegacyModalRoot && LegacyModalContent && LegacyModalHeader) {
        return (
            <LegacyModalRoot transitionState={transitionState} size={ModalSize.MEDIUM}>
                <LegacyModalHeader separator={false}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
                        <Forms.FormTitle tag="h2" style={{ margin: 0 }}>
                            {title}
                        </Forms.FormTitle>
                        {LegacyModalCloseButton ? (
                            <LegacyModalCloseButton onClick={onClose} />
                        ) : (
                            <button
                                type="button"
                                className="dmemoji-close-btn"
                                onClick={onClose}
                                aria-label="Close"
                            >
                                ✕
                            </button>
                        )}
                    </div>
                </LegacyModalHeader>
                <LegacyModalContent style={{ padding: "0 20px 20px 20px", maxHeight: "70vh", overflowY: "auto" }}>
                    {children}
                </LegacyModalContent>
            </LegacyModalRoot>
        );
    }

    return (
        <div
            className="dmemoji-standalone-modal-backdrop"
            onClick={e => {
                if (e.target === e.currentTarget) onClose();
            }}
        >
            <div className="dmemoji-standalone-modal-shell" role="dialog" aria-modal="true" aria-label={title}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%", marginBottom: 12 }}>
                    <Forms.FormTitle tag="h2" style={{ margin: 0 }}>
                        {title}
                    </Forms.FormTitle>
                    <button type="button" className="dmemoji-close-btn" onClick={onClose} aria-label="Close">
                        ✕
                    </button>
                </div>
                <div>{children}</div>
            </div>
        </div>
    );
}

function TranslationModal({
    original,
    translation,
    sourceLanguage,
    targetLanguage,
    engineName,
    onClose,
    transitionState
}: {
    original: string;
    translation: string;
    sourceLanguage: string;
    targetLanguage: string;
    engineName: string;
    onClose: () => void;
    transitionState?: any;
}) {
    const srcLabel = languageLabel(sourceLanguage);
    const targetLabel = languageLabel(targetLanguage);

    return (
        <ErrorBoundary message="Could not display translation modal">
            <SafeModalContainer transitionState={transitionState} onClose={onClose} title={`Translation (${srcLabel} → ${targetLabel})`}>
                <div className="dm-translate-modal">
                    <div className="dm-translate-box dm-translate-box-result">
                        <div className="dm-translate-box-header">
                            <span className="dm-translate-label">{targetLabel} Translation</span>
                            <Button
                                size={Button.Sizes.MIN}
                                color={Button.Colors.BRAND}
                                onClick={() => void copyWithToast(translation, "Translation copied to clipboard!")}
                            >
                                Copy Translation
                            </Button>
                        </div>
                        <div className="dm-translate-text">{translation}</div>
                    </div>

                    <div className="dm-translate-box">
                        <div className="dm-translate-box-header">
                            <span className="dm-translate-label">Original ({srcLabel})</span>
                            <Button
                                size={Button.Sizes.MIN}
                                color={Button.Colors.PRIMARY}
                                onClick={() => void copyWithToast(original, "Original message copied to clipboard!")}
                            >
                                Copy Original
                            </Button>
                        </div>
                        <div className="dm-translate-text">{original}</div>
                    </div>

                    <div className="dm-translate-meta">
                        <span>Engine: {engineName}</span>
                        <Button size={Button.Sizes.SMALL} color={Button.Colors.PRIMARY} onClick={onClose}>
                            Close
                        </Button>
                    </div>
                </div>
            </SafeModalContainer>
        </ErrorBoundary>
    );
}

const TranslationSetters = new Map<string, (v: TranslationResult | undefined) => void>();

export function handleTranslate(messageId: string, data: TranslationResult | undefined) {
    TranslationSetters.get(messageId)?.(data);
}

function TranslationAccessory({ message }: { message: Message; }) {
    const [translation, setTranslation] = useState<TranslationResult | undefined>();

    useEffect(() => {
        TranslationSetters.set(message.id, setTranslation);
        return () => {
            TranslationSetters.delete(message.id);
        };
    }, [message.id]);

    if (!translation) return null;

    const srcLabel = languageLabel(translation.sourceLanguage);
    const targetLabel = languageLabel((settings.store.targetLanguage as string) || "en");

    return (
        <div className="dm-translate-accessory" role="region" aria-label="Translation">
            <div className="dm-translate-accessory-header">
                <TranslateIcon width={14} height={14} />
                <span>Translated from {srcLabel} to {targetLabel}</span>
            </div>
            <div className="dm-translate-accessory-body">{translation.translation}</div>
            <div className="dm-translate-accessory-actions">
                <button
                    type="button"
                    className="dm-translate-link-btn"
                    onClick={() => void copyWithToast(translation.translation, "Translation copied to clipboard!")}
                >
                    Copy
                </button>
                <span style={{ color: "var(--text-muted)" }}>·</span>
                <button
                    type="button"
                    className="dm-translate-link-btn"
                    onClick={() => setTranslation(undefined)}
                >
                    Dismiss
                </button>
            </div>
        </div>
    );
}

async function openTranslation(message: Message) {
    const original = getMessageContent(message).trim();
    if (!original) {
        Toasts.show({
            message: "This message has no text to translate.",
            type: Toasts.Type.FAILURE,
            id: Toasts.genId()
        });
        return;
    }

    const toastId = Toasts.genId();
    Toasts.show({
        message: "Translating message...",
        type: Toasts.Type.NORMAL,
        id: toastId
    });

    try {
        const result = await translateText(original);
        const targetLang = (settings.store.targetLanguage as string) || "en";

        // 1. Dispatch inline translation underneath message
        handleTranslate(message.id, result);

        // 2. Open clean translation modal with copy buttons
        openModal(props => (
            <TranslationModal
                {...props}
                original={original}
                translation={result.translation}
                sourceLanguage={result.sourceLanguage}
                targetLanguage={targetLang}
                engineName={result.engine}
            />
        ));

        Toasts.show({
            message: `Translated from ${languageLabel(result.sourceLanguage)} to ${languageLabel(targetLang)}`,
            type: Toasts.Type.SUCCESS,
            id: toastId
        });
    } catch (error) {
        console.error("[DMTranslate] translation failed:", error);
        Toasts.show({
            message: "Translation failed. Check your internet connection and try again.",
            type: Toasts.Type.FAILURE,
            id: toastId
        });
    }
}

const messageContextPatch: NavContextMenuPatchCallback = (children, props: { message?: Message; }) => {
    const message = props?.message;
    if (!message) return;
    const content = getMessageContent(message);
    if (!content) return;

    const group = findGroupChildrenByChildId("copy-text", children);
    if (!group) return;

    const targetLabel = languageLabel(settings.store.targetLanguage);
    const item = (
        <Menu.MenuItem
            id="dm-translate-message"
            label={`Translate to ${targetLabel}`}
            icon={TranslateIcon}
            leadingAccessory={{ type: "icon", icon: TranslateIcon }}
            action={() => void openTranslation(message)}
        />
    );
    const copyIndex = group.findIndex(child => child?.props?.id === "copy-text");
    group.splice(copyIndex >= 0 ? copyIndex + 1 : group.length, 0, item);
};

export default definePlugin({
    name: "DMTranslate",
    description:
        "Instant multi-engine message translation. Right-click any message → Translate; auto-detects any language with Google Translate & DeepL fallbacks.",
    authors: [{ name: "Diggy", id: 0n }],
    settings,
    contextMenus: {
        message: messageContextPatch
    },
    renderMessageAccessory: props => <TranslationAccessory message={props.message} />
});
