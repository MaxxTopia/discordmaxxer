/*
 * Vesktop, a desktop app aiming to give you a snappier Discord Experience
 * Copyright (c) 2023 Vendicated and Vencord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// @vencord/venmic is an optional Linux-only native dependency. Keep the
// narrow interface used by Vesktop local so Windows type checks do not need
// the native package installed.

export type Node = Record<string, string>;

export interface LinkData {
    include: Node[];
    exclude: Node[];
    ignore_devices?: boolean;
    workaround?: Node[];
    only_speakers?: boolean;
    only_default_speakers?: boolean;
}

export interface PatchBay {
    list(fields?: string[]): Node[];
    link(data: LinkData): unknown;
    unlink(): unknown;
}

export interface PatchBayConstructor {
    new (): PatchBay;
    hasPipeWire(): boolean;
}

export interface VenmicModule {
    PatchBay: PatchBayConstructor;
}
