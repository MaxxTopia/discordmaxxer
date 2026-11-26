import { Button as VencordButton, type ButtonProps, type ButtonSize, type ButtonVariant } from "@components/Button";
import { Heading } from "@components/Heading";
import { Paragraph } from "@components/Paragraph";
import { React } from "@webpack/common";
import type { ComponentProps, ComponentPropsWithRef } from "react";

import { showDiscordmaxxerStatusToast } from "./statusToast";

/**
 * Small compatibility surface for custom plugins that historically imported
 * Discord's lazy Button/Forms/Toasts modules from @webpack/common.
 *
 * These are deliberately owned by Discordmaxxer. Vencord's common exports are
 * upstream internals and have changed repeatedly; keeping the legacy shape at
 * this boundary lets the plugins survive those changes without patching
 * Vencord's core source or spreading version checks through every plugin.
 */

const ButtonSizes = {
    MIN: "min",
    MINI: "min",
    SMALL: "small",
    MEDIUM: "medium",
    LARGE: "medium"
} as const;

const ButtonColors = {
    BRAND: "brand",
    PRIMARY: "primary",
    SECONDARY: "secondary",
    GREEN: "green",
    RED: "red",
    LINK: "link"
} as const;

type LegacyButtonSize = ButtonSize | (typeof ButtonSizes)[keyof typeof ButtonSizes];
type LegacyButtonColor = keyof typeof ButtonColors | (typeof ButtonColors)[keyof typeof ButtonColors];
type LegacyButtonProps = Omit<ComponentPropsWithRef<"button">, "color"> & {
    color?: LegacyButtonColor;
    look?: string;
    size?: LegacyButtonSize;
    variant?: ButtonVariant;
};

function variantForColor(color: LegacyButtonColor | undefined): ButtonVariant {
    switch (String(color ?? "").toLowerCase()) {
        case "red":
        case "danger":
            return "dangerPrimary";
        case "green":
        case "success":
            return "positive";
        case "secondary":
            return "secondary";
        case "link":
            return "link";
        default:
            return "primary";
    }
}

function LegacyButton({ color, look: _look, size = ButtonSizes.MEDIUM, variant, ...props }: LegacyButtonProps) {
    return (
        <VencordButton
            {...props}
            size={size as ButtonProps["size"]}
            variant={variant ?? variantForColor(color)}
        />
    );
}

export const Button = Object.assign(LegacyButton, {
    Sizes: ButtonSizes,
    Colors: ButtonColors
});

type FormTitleProps = ComponentProps<typeof Heading>;
type FormTextProps = ComponentProps<typeof Paragraph>;

function FormTitle(props: FormTitleProps) {
    return <Heading {...props} />;
}

function FormText(props: FormTextProps) {
    return <Paragraph {...props} />;
}

export const Forms = { FormTitle, FormText };

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
    genId: () => `discordmaxxer-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    show: showDiscordmaxxerStatusToast
};
