/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2026 Vendicated and Vesktop contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * Discordmaxxer compatibility types for the Vencord 1.15.x transition.
 *
 * Vencord keeps the legacy modal components at runtime for existing plugins,
 * but intentionally types them as `never` while callers migrate to the new
 * Modal API. Keep the Vesktop-owned renderer code readable and isolated from
 * that type-only deprecation boundary here.
 */

import { Heading, Text } from "@vencord/types/components";
import * as LegacyUtils from "@vencord/types/utils";
import { showToast } from "@vencord/types/webpack/common";
import type { ComponentType, CSSProperties, ReactNode } from "react";

type LegacyComponentProps = {
    children?: ReactNode;
    className?: string;
    onClick?: () => void;
    onClose?: () => void;
    size?: string;
    style?: CSSProperties;
    transitionState?: number;
    [key: string]: unknown;
};

type LegacyComponent = ComponentType<LegacyComponentProps>;

type LegacyModalExports = {
    ModalRoot: LegacyComponent;
    ModalHeader: LegacyComponent;
    ModalContent: LegacyComponent;
    ModalFooter: LegacyComponent;
    ModalCloseButton: LegacyComponent;
};

type LegacyUtilsExports = {
    Modals: LegacyModalExports;
    ModalRoot: LegacyComponent;
    ModalHeader: LegacyComponent;
    ModalContent: LegacyComponent;
    ModalFooter: LegacyComponent;
    ModalCloseButton: LegacyComponent;
};

const { Modals, ModalRoot, ModalHeader, ModalContent, ModalFooter, ModalCloseButton } =
    LegacyUtils as unknown as LegacyUtilsExports;

/** Deprecated Vencord components that remain runtime-compatible in 1.15.x. */
export { ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalRoot, Modals };

export const ModalSize = {
    SMALL: "small",
    MEDIUM: "medium",
    LARGE: "large",
    DYNAMIC: "dynamic"
} as const;

/** The old BaseText/HeadingTertiary names now map to the current text system. */
export const BaseText = Text as unknown as LegacyComponent;
export const HeadingTertiary = Heading as unknown as LegacyComponent;

type LegacyToastType = "message" | "normal" | "success" | "failure" | "error";

type LegacyToast = {
    message: string;
    type?: LegacyToastType | string;
    id?: string;
    duration?: number;
    position?: "top" | "bottom" | string;
};

const showToastCompat = showToast as unknown as (data: {
    text: string;
    variant?: "default" | "success" | "critical";
    position?: "top" | "bottom";
    duration?: number;
}) => void;

/** Small adapter for the removed webpack/common Toasts facade. */
export const Toasts = {
    Type: {
        MESSAGE: "message",
        NORMAL: "normal",
        SUCCESS: "success",
        FAILURE: "failure",
        ERROR: "error"
    } as const,
    Position: {
        TOP: "top",
        BOTTOM: "bottom"
    } as const,
    genId: () => `discordmaxxer-toast-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    show({ message, type, duration, position }: LegacyToast): void {
        const normalizedType = String(type ?? "message").toLowerCase();
        showToastCompat({
            text: message,
            variant:
                normalizedType.includes("failure") || normalizedType.includes("error")
                    ? "critical"
                    : normalizedType.includes("success")
                      ? "success"
                      : "default",
            position: position === "bottom" ? "bottom" : "top",
            duration
        });
    }
};
