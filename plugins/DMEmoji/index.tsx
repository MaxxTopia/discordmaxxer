/*
 * Discordmaxxer DMEmoji
 * Local animated emoji library for chat attachments, with an optional bridge
 * to real Discord custom emoji reactions when an emoji identity is available.
 */

import "./styles.css";

import * as DataStore from "@api/DataStore";
import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Devs } from "@utils/constants";
import { ModalCloseButton, ModalContent, ModalHeader, ModalRoot, ModalSize } from "@utils/modal";
import definePlugin, { IconComponent, OptionType } from "@utils/types";
import { Message, RenderModalProps } from "@vencord/discord-types";
import {
    Button,
    ChannelStore,
    DraftType,
    Forms,
    Menu,
    MessageActions,
    openModal,
    Toasts,
    UploadHandler,
    useEffect,
    useRef,
    useState
} from "@webpack/common";

const RECORDS_KEY = "Discordmaxxer_DMEmoji_records";
const FILE_KEY_PREFIX = "Discordmaxxer_DMEmoji_file_";
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const ACCEPTED_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

// Legacy modal aliases from @utils/modal
const LegacyModalRoot: any = ModalRoot;
const LegacyModalHeader: any = ModalHeader;
const LegacyModalContent: any = ModalContent;
const LegacyModalCloseButton: any = ModalCloseButton;

type EmojiRecord = {
    id: string;
    name: string;
    fileName: string;
    mime: string;
    size: number;
    createdAt: number;
    discordEmojiRef?: string;
};

let emojiRecordsCache: EmojiRecord[] = [];

function fileKey(id: string): string {
    return `${FILE_KEY_PREFIX}${id}`;
}

function safeEmojiName(fileName: string): string {
    const withoutExtension = fileName.replace(/\.[^.]+$/, "");
    const cleaned = withoutExtension
        .replace(/[^a-zA-Z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 28);
    return cleaned || "local-emoji";
}

function extensionForMime(mime: string): string {
    if (mime === "image/gif") return "gif";
    if (mime === "image/webp") return "webp";
    if (mime === "image/jpeg") return "jpg";
    return "png";
}

function emojiFileName(record: EmojiRecord): string {
    const extension = extensionForMime(record.mime);
    return `${record.name}.${extension}`;
}

async function readRecords(): Promise<EmojiRecord[]> {
    try {
        const records = await DataStore.get<EmojiRecord[]>(RECORDS_KEY);
        return Array.isArray(records)
            ? records.filter(record => record && typeof record.id === "string" && typeof record.name === "string")
            : [];
    } catch (error) {
        console.warn("[DMEmoji] Could not read the local emoji library", error);
        return [];
    }
}

async function getEmojiFile(record: EmojiRecord): Promise<File | null> {
    try {
        const stored = await DataStore.get<any>(fileKey(record.id));
        if (!stored) return null;
        if (stored instanceof File) return stored;
        if (stored instanceof Blob) {
            return new File([stored], emojiFileName(record), { type: record.mime || stored.type || "image/png" });
        }
        if (stored instanceof ArrayBuffer || ArrayBuffer.isView(stored)) {
            return new File([stored], emojiFileName(record), { type: record.mime || "image/png" });
        }
        if (typeof (stored as Blob).arrayBuffer === "function") {
            const buf = await (stored as Blob).arrayBuffer();
            return new File([buf], emojiFileName(record), { type: record.mime || "image/png" });
        }
        return null;
    } catch (error) {
        console.warn("[DMEmoji] Could not read local emoji", error);
        return null;
    }
}

async function saveRecords(records: EmojiRecord[]): Promise<void> {
    emojiRecordsCache = records;
    await DataStore.set(RECORDS_KEY, records);
}

async function importEmoji(file: File): Promise<EmojiRecord> {
    if (!ACCEPTED_TYPES.has(file.type)) throw new Error("Use a PNG, JPG, GIF, or WebP image.");
    if (file.size > MAX_FILE_BYTES) throw new Error("That image is over the 4 MB local library limit.");

    const record: EmojiRecord = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`,
        name: safeEmojiName(file.name),
        fileName: file.name,
        mime: file.type,
        size: file.size,
        createdAt: Date.now()
    };

    const records = await readRecords();
    await DataStore.set(fileKey(record.id), new File([file], file.name, { type: file.type }));
    await saveRecords([...records, record]);
    return record;
}

async function removeEmoji(record: EmojiRecord): Promise<void> {
    const records = (await readRecords()).filter(candidate => candidate.id !== record.id);
    await DataStore.del(fileKey(record.id));
    await saveRecords(records);
}

async function updateEmoji(record: EmojiRecord, patch: Partial<EmojiRecord>): Promise<EmojiRecord[]> {
    const records = await readRecords();
    const next = records.map(candidate => (candidate.id === record.id ? { ...candidate, ...patch } : candidate));
    await saveRecords(next);
    return next;
}

async function sendEmojiAsImage(record: EmojiRecord, channelId: string, onDone?: () => void): Promise<void> {
    try {
        const file = await getEmojiFile(record);
        if (!file) {
            Toasts.show({
                message: `The local file for ${record.name} is missing. Re-import it in DMEmoji settings.`,
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE
            });
            return;
        }

        const channel = ChannelStore.getChannel(channelId);
        if (!channel) {
            Toasts.show({
                message: "Could not find current chat channel.",
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE
            });
            return;
        }

        UploadHandler.promptToUpload([file], channel, DraftType.ChannelMessage);
        Toasts.show({
            message: `${record.name} added to the message`,
            id: Toasts.genId(),
            type: Toasts.Type.SUCCESS
        });
        onDone?.();
    } catch (error) {
        console.error("[DMEmoji] Could not send emoji as image", error);
        Toasts.show({
            message: "Failed to attach emoji to message",
            id: Toasts.genId(),
            type: Toasts.Type.FAILURE
        });
    }
}

function parseDiscordEmojiRef(
    value: string | undefined,
    fallbackName: string
): { id: string; name: string; isAnimated: boolean; } | null {
    const raw = value?.trim() ?? "";
    if (!raw) return null;
    const markup = raw.match(/^<(a?):([^:>]+):(\d+)>$/);
    if (markup) return { id: markup[3], name: markup[2], isAnimated: markup[1] === "a" };
    if (!/^\d{5,25}$/.test(raw)) return null;
    return { id: raw, name: fallbackName, isAnimated: false };
}

function reactWithEmoji(message: Message, record: EmojiRecord): void {
    const emoji = parseDiscordEmojiRef(record.discordEmojiRef, record.name);
    const addReaction = (MessageActions as any)?.addReaction;
    if (!emoji || typeof addReaction !== "function") {
        Toasts.show({
            message:
                "This local image can be sent as an attachment, but it has no usable Discord emoji identity for reactions.",
            id: Toasts.genId(),
            type: Toasts.Type.FAILURE
        });
        return;
    }

    try {
        addReaction(message.channel_id, message.id, { id: emoji.id, name: emoji.name, animated: emoji.isAnimated });
        Toasts.show({ message: `Reacted with ${record.name}`, id: Toasts.genId(), type: Toasts.Type.SUCCESS });
    } catch (error) {
        console.warn("[DMEmoji] Discord reaction failed", error);
        Toasts.show({
            message: "Discord rejected that emoji reaction. Check the native emoji ID and permissions.",
            id: Toasts.genId(),
            type: Toasts.Type.FAILURE
        });
    }
}

function DMEmojiIcon({ height = 20, width = 20, className }: { height?: number; width?: number; className?: string; }) {
    return (
        <svg aria-hidden="true" role="img" width={width} height={height} className={className} viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="2" />
            <circle cx="9" cy="10" r="1.25" fill="currentColor" />
            <circle cx="15" cy="10" r="1.25" fill="currentColor" />
            <path
                d="M8 14c1.1 1.6 2.45 2.35 4 2.35S14.9 15.6 16 14"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeWidth="2"
            />
        </svg>
    );
}

function useEmojiLibrary() {
    const [records, setRecords] = useState<EmojiRecord[]>(emojiRecordsCache);
    const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
    const [refreshToken, setRefreshToken] = useState(0);

    useEffect(() => {
        let alive = true;
        const createdUrls: string[] = [];

        void (async () => {
            try {
                const loaded = await readRecords();
                if (!alive) return;
                emojiRecordsCache = loaded;
                setRecords(loaded);

                const nextUrls: Record<string, string> = {};
                for (const record of loaded) {
                    if (!alive) break;
                    const file = await getEmojiFile(record);
                    if (!alive || !file) continue;
                    const url = URL.createObjectURL(file);
                    createdUrls.push(url);
                    nextUrls[record.id] = url;
                }
                if (!alive) return;
                setPreviewUrls(nextUrls);
            } catch (err) {
                console.error("[DMEmoji] Error loading emoji library", err);
            }
        })();

        return () => {
            alive = false;
            createdUrls.forEach(url => URL.revokeObjectURL(url));
        };
    }, [refreshToken]);

    return { records, setRecords, previewUrls, refresh: () => setRefreshToken(value => value + 1) };
}

function EmojiLibrary({
    channelId,
    onClose,
    modal = false
}: {
    channelId?: string;
    onClose?: () => void;
    modal?: boolean;
}) {
    const { records, setRecords, previewUrls, refresh } = useEmojiLibrary();
    const [status, setStatus] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);

    async function handleImport(file: File | undefined) {
        if (!file) return;
        try {
            const record = await importEmoji(file);
            setRecords(await readRecords());
            refresh();
            setStatus(`${record.name} added. Use its image button to place it in chat.`);
        } catch (error) {
            setStatus(error instanceof Error ? error.message : "Could not import that image.");
        }
    }

    return (
        <div className={modal ? "dmemoji-modal" : "dmemoji-settings"}>
            <div className="dmemoji-toolbar">
                <div>
                    <Forms.FormTitle>Local emoji library</Forms.FormTitle>
                    <Forms.FormText>
                        Import animated or still images once, then place them into a message from the DMEmoji button.
                    </Forms.FormText>
                </div>
                <Button size={Button.Sizes.SMALL} color={Button.Colors.BRAND} onClick={() => inputRef.current?.click()}>
                    Import image
                </Button>
                <input
                    ref={inputRef}
                    className="dmemoji-hidden-input"
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp"
                    onChange={event => {
                        void handleImport(event.currentTarget.files?.[0]);
                        event.currentTarget.value = "";
                    }}
                />
            </div>
            {status && <Forms.FormText className="dmemoji-status">{status}</Forms.FormText>}
            {!records.length && (
                <Forms.FormText>Nothing imported yet. The file stays local to this Discordmaxxer client.</Forms.FormText>
            )}
            <div className="dmemoji-grid">
                {records.map(record => (
                    <div className="dmemoji-entry" key={record.id}>
                        <div className="dmemoji-preview-wrap">
                            {previewUrls[record.id] ? (
                                <img className="dmemoji-preview" src={previewUrls[record.id]} alt={record.name} />
                            ) : (
                                <div className="dmemoji-preview dmemoji-preview-missing">?</div>
                            )}
                        </div>
                        <div className="dmemoji-entry-body">
                            <strong>{record.name}</strong>
                            <span className="dmemoji-meta">
                                {Math.max(1, Math.round(record.size / 1024))} KB{" "}
                                {record.mime === "image/gif" || record.mime === "image/webp"
                                    ? "animated-capable"
                                    : "image"}
                            </span>
                            {modal && channelId ? (
                                <div className="dmemoji-entry-actions">
                                    <Button
                                        size={Button.Sizes.SMALL}
                                        color={Button.Colors.BRAND}
                                        onClick={() => void sendEmojiAsImage(record, channelId, onClose)}
                                    >
                                        Add to message
                                    </Button>
                                </div>
                            ) : (
                                <input
                                    className="dmemoji-native-input"
                                    value={record.discordEmojiRef ?? ""}
                                    placeholder="Optional Discord emoji ID or <a:name:id>"
                                    onChange={event => {
                                        const value = event.currentTarget.value;
                                        void updateEmoji(record, { discordEmojiRef: value }).then(setRecords);
                                    }}
                                />
                            )}
                            {!modal && (
                                <Button
                                    size={Button.Sizes.SMALL}
                                    color={Button.Colors.PRIMARY}
                                    onClick={() =>
                                        void removeEmoji(record).then(async () => {
                                            setRecords(await readRecords());
                                            refresh();
                                        })
                                    }
                                >
                                    Remove
                                </Button>
                            )}
                        </div>
                    </div>
                ))}
            </div>
            <Forms.FormText className="dmemoji-footnote">
                Local files are attachments, not Discord reaction identities. Add a real Discord custom emoji ID above
                if you want the message context menu to react with it.
            </Forms.FormText>
        </div>
    );
}

function SafeModalContainer({
    transitionState,
    onClose,
    children
}: {
    transitionState?: any;
    onClose: () => void;
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
            <LegacyModalRoot transitionState={transitionState} size={ModalSize.MEDIUM} className="dmemoji-modal-root">
                <LegacyModalHeader separator={false} className="dmemoji-modal-header">
                    <div className="dmemoji-modal-header-inner">
                        <Forms.FormTitle tag="h2" style={{ margin: 0 }}>
                            DMEmoji
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
                <LegacyModalContent className="dmemoji-modal-content">{children}</LegacyModalContent>
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
            <div className="dmemoji-standalone-modal-shell" role="dialog" aria-modal="true" aria-label="DMEmoji">
                <div className="dmemoji-modal-header-inner">
                    <Forms.FormTitle tag="h2" style={{ margin: 0 }}>
                        DMEmoji
                    </Forms.FormTitle>
                    <button type="button" className="dmemoji-close-btn" onClick={onClose} aria-label="Close">
                        ✕
                    </button>
                </div>
                <div className="dmemoji-modal-content">{children}</div>
            </div>
        </div>
    );
}

function EmojiPickerModal(props: RenderModalProps & { channelId: string; }) {
    return (
        <ErrorBoundary message="Could not display DMEmoji picker">
            <SafeModalContainer transitionState={props.transitionState} onClose={props.onClose}>
                <EmojiLibrary channelId={props.channelId} onClose={props.onClose} modal />
            </SafeModalContainer>
        </ErrorBoundary>
    );
}

const DMEmojiButton: ChatBarButtonFactory = ({ isAnyChat, channel }) => {
    const { showButton } = settings.use(["showButton"]);
    const channelId = channel?.id;
    if (!isAnyChat || !showButton || !channelId) return null;
    return (
        <ChatBarButton
            tooltip="Open DMEmoji"
            onClick={() => {
                try {
                    openModal(props => <EmojiPickerModal {...props} channelId={channelId} />);
                } catch (error) {
                    console.error("[DMEmoji] Failed to open modal", error);
                    Toasts.show({
                        message: "Could not open DMEmoji picker",
                        id: Toasts.genId(),
                        type: Toasts.Type.FAILURE
                    });
                }
            }}
            buttonProps={{ "aria-haspopup": "dialog" }}
        >
            <DMEmojiIcon />
        </ChatBarButton>
    );
};

const messageContextMenuPatch: NavContextMenuPatchCallback = (children, props: { message?: Message; }) => {
    const message = props?.message;
    if (!message || !emojiRecordsCache.length) return;
    children.push(
        <Menu.MenuItem id="dmemoji-message-actions" label="DMEmoji">
            {emojiRecordsCache.map(record => {
                const nativeEmoji = parseDiscordEmojiRef(record.discordEmojiRef, record.name);
                return (
                    <Menu.MenuItem id={`dmemoji-actions-${record.id}`} key={record.id} label={record.name}>
                        <Menu.MenuItem
                            id={`dmemoji-send-${record.id}`}
                            label="Send as image"
                            action={() => void sendEmojiAsImage(record, message.channel_id)}
                        />
                        <Menu.MenuItem
                            id={`dmemoji-react-${record.id}`}
                            label={nativeEmoji ? "React with native Discord emoji" : "React unavailable for local file"}
                            disabled={!nativeEmoji}
                            action={() => reactWithEmoji(message, record)}
                        />
                    </Menu.MenuItem>
                );
            })}
        </Menu.MenuItem>
    );
};

const settings = definePluginSettings({
    showButton: {
        type: OptionType.BOOLEAN,
        description: "Show the DMEmoji button beside the message composer",
        default: true
    },
    library: {
        type: OptionType.COMPONENT,
        description: "Manage imported local emojis",
        component: () => <EmojiLibrary />
    }
});

export default definePlugin({
    name: "DMEmoji",
    description:
        "Keep a local animated emoji library, attach it to messages, and use native Discord emoji IDs for real reactions.",
    tags: ["Chat", "Emotes", "Media"],
    authors: [{ name: "Diggy", id: 0n }],
    settings,
    chatBarButton: {
        icon: DMEmojiIcon as IconComponent,
        render: DMEmojiButton
    },
    contextMenus: {
        message: messageContextMenuPatch
    },
    async start() {
        emojiRecordsCache = await readRecords();
    },
    stop() {
        emojiRecordsCache = [];
    }
});
