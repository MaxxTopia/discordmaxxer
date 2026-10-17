/*
 * Discordmaxxer — DMTranslate plugin
 * Copyright (c) 2026 Diggy
 * SPDX-License-Identifier: GPL-3.0-or-later
 *
 * Standalone message translation. Right-click a message and choose Translate;
 * no helper app, Python environment, or extra download is required.
 */

import { findGroupChildrenByChildId, NavContextMenuPatchCallback } from "@api/ContextMenu";
import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { Message } from "@vencord/discord-types";
import { Alerts, Menu, React, Toasts } from "@webpack/common";

const GOOGLE_TRANSLATE_KEY = "AIzaSyDLEeFI5OtFBwYBIoK_jj5m32rZK5CkCXA";
const MAX_MESSAGE_LENGTH = 5000;

const LANGUAGE_OPTIONS = [
    { label: "English", value: "en", default: true },
    { label: "Spanish", value: "es" },
    { label: "French", value: "fr" },
    { label: "German", value: "de" },
    { label: "Japanese", value: "ja" },
    { label: "Korean", value: "ko" },
    { label: "Portuguese", value: "pt" },
    { label: "Chinese (Simplified)", value: "zh-CN" }
] as const;

type LanguageCode = typeof LANGUAGE_OPTIONS[number]["value"];

const settings = definePluginSettings({
    targetLanguage: {
        type: OptionType.SELECT,
        description: "Language used when you choose Translate from a message's right-click menu.",
        default: "en" as LanguageCode,
        options: LANGUAGE_OPTIONS
    }
});

function TranslateIcon() {
    return (
        <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
            <path
                fill="currentColor"
                d="M12 2a10 10 0 100 20 10 10 0 000-20zm6.93 6H15.9a15.6 15.6 0 00-1.38-3.56A8.03 8.03 0 0118.93 8zM12 4.04c.83 1.2 1.48 2.53 1.91 3.96h-3.82c.43-1.43 1.08-2.76 1.91-3.96zM4.26 14a7.82 7.82 0 010-4h3.38a16.5 16.5 0 000 4H4.26zm.81 2h3.03c.34 1.28.8 2.5 1.38 3.56A7.99 7.99 0 015.07 16zm3.03-8H5.07a7.99 7.99 0 014.41-3.56A15.6 15.6 0 008.1 8zM12 19.96c-.83-1.2-1.48-2.53-1.91-3.96h3.82A13.7 13.7 0 0112 19.96zM14.34 14H9.66a14.9 14.9 0 010-4h4.68a14.9 14.9 0 010 4zm.25 5.56c.58-1.06 1.04-2.28 1.38-3.56h3.03a7.99 7.99 0 01-4.41 3.56zM16.36 14a16.5 16.5 0 000-4h3.38a7.82 7.82 0 010 4h-3.38z"
            />
        </svg>
    );
}

interface GoogleTranslationResponse {
    translation?: string;
    sourceLanguage?: string;
}

function getMessageContent(message: Message): string {
    return message.content
        || message.messageSnapshots?.[0]?.message.content
        || message.embeds?.find(embed => embed.type === "auto_moderation_message")?.rawDescription
        || "";
}

function languageLabel(code: string): string {
    return LANGUAGE_OPTIONS.find(option => option.value === code)?.label ?? code;
}

async function translateText(text: string): Promise<GoogleTranslationResponse> {
    const targetLanguage = settings.store.targetLanguage as LanguageCode;
    const url = "https://translate-pa.googleapis.com/v1/translate?" + new URLSearchParams({
        "params.client": "gtx",
        "dataTypes": "TRANSLATION",
        "key": GOOGLE_TRANSLATE_KEY,
        "query.sourceLanguage": "auto",
        "query.targetLanguage": targetLanguage,
        "query.text": text.slice(0, MAX_MESSAGE_LENGTH)
    });

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Translation request failed (${response.status} ${response.statusText})`);
    }

    const data: GoogleTranslationResponse = await response.json();
    if (!data.translation?.trim()) {
        throw new Error("The translation service returned no translated text.");
    }
    return data;
}

async function openTranslation(message: Message) {
    const original = getMessageContent(message).trim();
    if (!original) return;

    try {
        const result = await translateText(original);
        const source = result.sourceLanguage ? ` · from ${result.sourceLanguage}` : "";
        const truncatedNote = original.length > MAX_MESSAGE_LENGTH
            ? `\n\nOnly the first ${MAX_MESSAGE_LENGTH.toLocaleString()} characters were translated.`
            : "";

        Alerts.show({
            title: `Translation${source}`,
            body: `${result.translation}\n\nOriginal:\n${original}${truncatedNote}`,
            confirmText: "Close"
        });
    } catch (error) {
        console.warn("[DiscordmaxxerTranslate] translation failed:", error);
        Toasts.show({
            message: "Could not translate this message. Check your connection and try again.",
            type: Toasts.Type.FAILURE,
            id: Toasts.genId()
        });
    }
}

const messageContextPatch: NavContextMenuPatchCallback = (children, { message }: { message: Message; }) => {
    const content = getMessageContent(message);
    if (!content) return;

    const group = findGroupChildrenByChildId("copy-text", children);
    if (!group) return;

    const item = (
        <Menu.MenuItem
            id="dm-translate-message"
            label={`Translate to ${languageLabel(settings.store.targetLanguage)}`}
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
        "Standalone message translation. Right-click any message → Translate; it uses a built-in Google Translate request and needs no Python helper, overlay, or separate download.",
    authors: [{ name: "Diggy", id: 0n }],
    settings,
    contextMenus: {
        message: messageContextPatch
    }
});
