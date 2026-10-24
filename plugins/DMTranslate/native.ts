/*
 * Discordmaxxer — DMTranslate plugin (native / main process)
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Runs translation HTTP requests from the Node.js main process, completely
 * bypassing Discord's renderer Content Security Policy (connect-src) and CORS
 * headers. Auto-detects all source languages (Japanese, Spanish, Russian,
 * Chinese, etc.) and translates to English (or user target language).
 */

import type { IpcMainInvokeEvent } from "electron";

const GOOGLE_TRANSLATE_KEY = "AIzaSyDLEeFI5OtFBwYBIoK_jj5m32rZK5CkCXA";
const MAX_MESSAGE_LENGTH = 5000;

export interface NativeTranslationResult {
    ok: boolean;
    translation?: string;
    sourceLanguage?: string;
    engine?: string;
    error?: string;
}

// Engine 1: Google Translate Single Endpoint (gtx client, auto-detect)
export async function translateViaGoogleSingle(
    _: IpcMainInvokeEvent,
    text: string,
    targetLang: string
): Promise<NativeTranslationResult> {
    try {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text.slice(0, MAX_MESSAGE_LENGTH))}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Google Translate HTTP ${res.status}`);
        const data = await res.json();
        if (!Array.isArray(data) || !Array.isArray(data[0])) throw new Error("Invalid Google response");
        const translation = data[0].map((chunk: any) => chunk?.[0] ?? "").join("").trim();
        if (!translation) throw new Error("Empty Google translation");
        const sourceLanguage = typeof data[2] === "string" ? data[2] : "auto";
        return { ok: true, translation, sourceLanguage, engine: "Google Translate" };
    } catch (err: any) {
        return { ok: false, error: String(err?.message ?? err) };
    }
}

// Engine 2: Google PA Translate Endpoint
export async function translateViaGooglePA(
    _: IpcMainInvokeEvent,
    text: string,
    targetLang: string
): Promise<NativeTranslationResult> {
    try {
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
            ok: true,
            translation: data.translation.trim(),
            sourceLanguage: data.sourceLanguage || "auto",
            engine: "Google Translate"
        };
    } catch (err: any) {
        return { ok: false, error: String(err?.message ?? err) };
    }
}

// Engine 3: MyMemory Endpoint
export async function translateViaMyMemory(
    _: IpcMainInvokeEvent,
    text: string,
    targetLang: string
): Promise<NativeTranslationResult> {
    try {
        const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.slice(0, 500))}&langpair=autodetect|${encodeURIComponent(targetLang)}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`MyMemory HTTP ${res.status}`);
        const data = await res.json();
        const translation = data.responseData?.translatedText?.trim();
        if (!translation || translation.startsWith("MYMEMORY WARNING")) throw new Error("Invalid MyMemory translation");
        const sourceLanguage = data.responseData?.detectedLanguage || "auto";
        return { ok: true, translation, sourceLanguage, engine: "MyMemory" };
    } catch (err: any) {
        return { ok: false, error: String(err?.message ?? err) };
    }
}

// Engine 4: DeepL Endpoint
export async function translateViaDeepL(
    _: IpcMainInvokeEvent,
    text: string,
    targetLang: string,
    apiKey: string
): Promise<NativeTranslationResult> {
    try {
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
        return { ok: true, translation, sourceLanguage, engine: "DeepL" };
    } catch (err: any) {
        return { ok: false, error: String(err?.message ?? err) };
    }
}
