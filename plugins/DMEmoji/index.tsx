/*
 * Discordmaxxer DMEmoji
 * A fast emoji drawer for native Discord emoji plus a private local media shelf.
 *
 * Native Unicode and guild emoji can be inserted or used as reactions. Imported
 * local images/GIFs remain attachments unless the user links them to a real
 * Discord custom emoji identity.
 */

import "./styles.css";

import * as DataStore from "@api/DataStore";
import { NavContextMenuPatchCallback } from "@api/ContextMenu";
import { ChatBarButton, ChatBarButtonFactory } from "@api/ChatButtons";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Devs } from "@utils/constants";
import { copyWithToast, insertTextIntoChatInputBox, sendMessage } from "@utils/discord";
import { ModalCloseButton, ModalContent, ModalHeader, ModalRoot, ModalSize } from "@utils/modal";
import definePlugin, { IconComponent, OptionType } from "@utils/types";
import { Message, RenderModalProps } from "@vencord/discord-types";
import {
    Button,
    ChannelStore,
    DraftType,
    EmojiStore,
    Forms,
    GuildStore,
    Menu,
    MessageActions,
    openModal,
    PendingReplyStore,
    SelectedChannelStore,
    Toasts,
    UploadHandler,
    useEffect,
    useMemo,
    useRef,
    useState
} from "@webpack/common";

const RECORDS_KEY = "Discordmaxxer_DMEmoji_records";
const FILE_KEY_PREFIX = "Discordmaxxer_DMEmoji_file_";
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const ACCEPTED_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const IEMOJI_KEYBOARD_URL = "https://www.iemoji.com/keyboard";

// Legacy modal aliases from @utils/modal.
const LegacyModalRoot: any = ModalRoot;
const LegacyModalHeader: any = ModalHeader;
const LegacyModalContent: any = ModalContent;
const LegacyModalCloseButton: any = ModalCloseButton;

type EmojiRecord = {
    id: string;
    name: string;
    fileName?: string;
    mime?: string;
    size?: number;
    createdAt: number;
    discordEmojiRef?: string;
};

type NativeEmojiChoice = {
    key: string;
    kind: "unicode" | "custom";
    name: string;
    value: string;
    id?: string;
    animated: boolean;
    imageUrl?: string;
    sourceLabel: string;
    searchText: string;
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

function extensionForMime(mime = "image/png"): string {
    if (mime === "image/gif") return "gif";
    if (mime === "image/webp") return "webp";
    if (mime === "image/jpeg") return "jpg";
    return "png";
}

function emojiFileName(record: EmojiRecord): string {
    return `${record.name}.${extensionForMime(record.mime)}`;
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
    value: unknown,
    fallbackName: string
): { id: string; name: string; isAnimated: boolean; } | null {
    // DataStore can contain records written by older DMEmoji builds. Treat a
    // malformed optional field as an unlinked local image instead of allowing
    // a context-menu render to throw while Discord is opening it.
    const raw = typeof value === "string" ? value.trim() : "";
    if (!raw) return null;
    const markup = raw.match(/^<(a?):([^:>]+):(\d+)>$/);
    if (markup) return { id: markup[3], name: markup[2], isAnimated: markup[1] === "a" };
    if (!/^\d{5,25}$/.test(raw)) return null;
    return { id: raw, name: fallbackName, isAnimated: false };
}

function formatDiscordEmojiRef(choice: NativeEmojiChoice): string | undefined {
    if (choice.kind !== "custom" || !choice.id) return undefined;
    return `<${choice.animated ? "a" : ""}:${choice.name}:${choice.id}>`;
}

function getDiscordEmojiImageUrl(id: string, animated: boolean): string {
    const cdnHost = (window as any).GLOBAL_ENV?.CDN_HOST || "cdn.discordapp.com";
    return `https://${cdnHost}/emojis/${id}.${animated ? "gif" : "png"}?size=64&quality=lossless`;
}

function getNativeEmojiChoices(query: string, channelId?: string, customOnly = false): NativeEmojiChoice[] {
    try {
        const guildId = channelId ? ChannelStore.getChannel(channelId)?.guild_id : undefined;
        const context = EmojiStore.getDisambiguatedEmojiContext(guildId);
        const normalized = query.trim().replace(/^:/, "").replace(/:$/, "").toLocaleLowerCase();
        const choices: NativeEmojiChoice[] = [];
        const seen = new Set<string>();

        for (const emoji of context.getDisambiguatedEmoji()) {
            const isCustom = emoji.type === 1;
            if (customOnly && !isCustom) continue;

            const name = emoji.name;
            const names = isCustom ? [emoji.name] : emoji.names;
            const guildName = isCustom && emoji.guildId ? GuildStore.getGuild(emoji.guildId)?.name : undefined;
            const searchText = [...names, guildName ?? ""].join(" ").toLocaleLowerCase();
            if (normalized && !searchText.includes(normalized)) continue;

            const key = isCustom ? `custom:${emoji.id}` : `unicode:${emoji.surrogates}`;
            if (seen.has(key)) continue;
            seen.add(key);

            choices.push({
                key,
                kind: isCustom ? "custom" : "unicode",
                name,
                value: isCustom ? `<${emoji.animated ? "a" : ""}:${name}:${emoji.id}>` : emoji.surrogates,
                id: isCustom ? emoji.id : undefined,
                animated: isCustom ? emoji.animated : false,
                imageUrl: isCustom ? getDiscordEmojiImageUrl(emoji.id, emoji.animated) : emoji.url,
                sourceLabel: isCustom ? guildName || "Server emoji" : "Unicode emoji",
                searchText
            });
        }

        return choices
            .sort((a, b) => {
                if (!normalized) return a.kind === b.kind ? 0 : a.kind === "unicode" ? -1 : 1;
                const aStarts = a.searchText.startsWith(normalized);
                const bStarts = b.searchText.startsWith(normalized);
                if (aStarts !== bStarts) return aStarts ? -1 : 1;
                return a.name.localeCompare(b.name);
            })
            // Some accounts can access hundreds of server emoji. Keep the
            // drawer useful without rendering an unbounded Discord catalog.
            .slice(0, 240);
    } catch (error) {
        console.warn("[DMEmoji] Native emoji data is not ready", error);
        return [];
    }
}

function reactWithEmoji(message: Message, record: EmojiRecord): void {
    const emoji = parseDiscordEmojiRef(record.discordEmojiRef, record.name);
    const addReaction = (MessageActions as any)?.addReaction;
    if (!emoji || typeof addReaction !== "function") {
        Toasts.show({
            message:
                "This local image is an attachment. Link it to a real Discord custom emoji before using it as a reaction.",
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

function useNativeEmojiAction(message: Message | undefined, choice: NativeEmojiChoice, onClose?: () => void): void {
    if (message) {
        const addReaction = (MessageActions as any)?.addReaction;
        if (typeof addReaction !== "function") {
            Toasts.show({
                message: "Discord's reaction action is unavailable in this build.",
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE
            });
            return;
        }

        try {
            addReaction(message.channel_id, message.id, {
                id: choice.kind === "custom" ? choice.id : undefined,
                name: choice.kind === "custom" ? choice.name : choice.value,
                animated: choice.animated
            });
            Toasts.show({ message: `Reacted with :${choice.name}:`, id: Toasts.genId(), type: Toasts.Type.SUCCESS });
            onClose?.();
        } catch (error) {
            console.warn("[DMEmoji] Native reaction failed", error);
            Toasts.show({
                message: "Discord rejected that reaction. The emoji may be unavailable in this channel.",
                id: Toasts.genId(),
                type: Toasts.Type.FAILURE
            });
        }
        return;
    }

    insertTextIntoChatInputBox(`${choice.value} `);
    onClose?.();
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

function SendMessageIcon({ height = 20, width = 20, className }: { height?: number; width?: number; className?: string; }) {
    return (
        <svg aria-hidden="true" role="img" width={width} height={height} className={className} viewBox="0 0 24 24">
            <path
                d="M3.4 4.2a1 1 0 0 1 1.28-.94l16.05 5.35a1.4 1.4 0 0 1 0 2.66L4.68 16.62a1 1 0 0 1-1.28-.94l-.25-4.22 9.1-.96a.5.5 0 0 0 0-1l-9.1-.96.25-4.34Z"
                fill="currentColor"
            />
            <path d="m3.15 11.5 9.1-1" fill="none" stroke="var(--background-primary, #313338)" strokeLinecap="round" strokeWidth="1.2" />
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

function NativeEmojiCard({
    choice,
    message,
    onClose
}: {
    choice: NativeEmojiChoice;
    message?: Message;
    onClose?: () => void;
}) {
    return (
        <div className="dmemoji-native-card">
            <button
                type="button"
                className="dmemoji-native-preview"
                onClick={() => useNativeEmojiAction(message, choice, onClose)}
                title={message ? "React with this emoji" : "Insert this emoji"}
            >
                {choice.imageUrl ? (
                    <img src={choice.imageUrl} alt={choice.name} loading="lazy" />
                ) : (
                    <span>{choice.value}</span>
                )}
            </button>
            <div className="dmemoji-native-copy">
                <strong>:{choice.name}:</strong>
                <span>{choice.sourceLabel}</span>
            </div>
            <div className="dmemoji-native-actions">
                <button
                    type="button"
                    className="dmemoji-action dmemoji-action-primary"
                    onClick={() => useNativeEmojiAction(message, choice, onClose)}
                >
                    {message ? "React" : "Insert"}
                </button>
                <button
                    type="button"
                    className="dmemoji-action"
                    onClick={() => void copyWithToast(choice.value, "Emoji copied!")}
                    aria-label={`Copy ${choice.name}`}
                >
                    Copy
                </button>
            </div>
        </div>
    );
}

function LocalEmojiEntry({
    record,
    previewUrl,
    channelId,
    message,
    modal,
    onClose,
    onRecordsChange,
    onRefresh
}: {
    record: EmojiRecord;
    previewUrl?: string;
    channelId?: string;
    message?: Message;
    modal: boolean;
    onClose?: () => void;
    onRecordsChange: (records: EmojiRecord[]) => void;
    onRefresh: () => void;
}) {
    const [linking, setLinking] = useState(false);
    const [linkQuery, setLinkQuery] = useState("");
    const native = parseDiscordEmojiRef(record.discordEmojiRef, record.name);
    const linkChoices = useMemo(
        () => getNativeEmojiChoices(linkQuery, channelId, true).slice(0, 10),
        [channelId, linkQuery]
    );

    async function linkNativeEmoji(choice: NativeEmojiChoice) {
        const ref = formatDiscordEmojiRef(choice);
        if (!ref) return;
        onRecordsChange(await updateEmoji(record, { discordEmojiRef: ref }));
        setLinking(false);
        setLinkQuery("");
    }

    return (
        <div className="dmemoji-local-card">
            <div className="dmemoji-preview-wrap">
                {previewUrl ? (
                    <img className="dmemoji-preview" src={previewUrl} alt={record.name} />
                ) : (
                    <div className="dmemoji-preview dmemoji-preview-missing">Missing</div>
                )}
            </div>
            <div className="dmemoji-entry-body">
                <strong>{record.name}</strong>
                <span className="dmemoji-meta">
                    {Math.max(1, Math.round((record.size ?? 0) / 1024))} KB {record.mime === "image/gif" || record.mime === "image/webp" ? "animated-capable" : "image"}
                </span>
                <span className={native ? "dmemoji-native-status" : "dmemoji-attachment-status"}>
                    {native ? `Reaction linked to :${native.name}:` : "Local attachment only"}
                </span>
                <div className="dmemoji-entry-actions">
                    {channelId && (
                        <button
                            type="button"
                            className="dmemoji-action dmemoji-action-primary"
                            onClick={() => void sendEmojiAsImage(record, channelId, onClose)}
                        >
                            Attach
                        </button>
                    )}
                    {message && native && (
                        <button type="button" className="dmemoji-action" onClick={() => reactWithEmoji(message, record)}>
                            React
                        </button>
                    )}
                    {!modal && (
                        <button type="button" className="dmemoji-action" onClick={() => setLinking(value => !value)}>
                            {native ? "Change link" : "Link reaction"}
                        </button>
                    )}
                    {!modal && (
                        <button
                            type="button"
                            className="dmemoji-action dmemoji-action-danger"
                            onClick={() =>
                                void removeEmoji(record).then(async () => {
                                    onRecordsChange(await readRecords());
                                    onRefresh();
                                })
                            }
                        >
                            Remove
                        </button>
                    )}
                </div>
                {!modal && linking && (
                    <div className="dmemoji-linker">
                        <input
                            className="dmemoji-native-input"
                            value={linkQuery}
                            placeholder="Search your server emoji"
                            onChange={event => setLinkQuery(event.currentTarget.value)}
                        />
                        <div className="dmemoji-link-results">
                            {linkChoices.map(choice => (
                                <button
                                    type="button"
                                    className="dmemoji-link-choice"
                                    key={choice.key}
                                    onClick={() => void linkNativeEmoji(choice)}
                                >
                                    {choice.imageUrl ? <img src={choice.imageUrl} alt="" /> : <span>{choice.value}</span>}
                                    <span>:{choice.name}:</span>
                                </button>
                            ))}
                            {!linkChoices.length && <span className="dmemoji-meta">No usable server emoji found.</span>}
                        </div>
                        <input
                            className="dmemoji-native-input"
                            value={record.discordEmojiRef ?? ""}
                            placeholder="Or paste <:name:id>"
                            onChange={event => {
                                const value = event.currentTarget.value;
                                void updateEmoji(record, { discordEmojiRef: value }).then(onRecordsChange);
                            }}
                        />
                    </div>
                )}
            </div>
        </div>
    );
}

function EmojiLibrary({
    channelId,
    message,
    onClose,
    modal = false
}: {
    channelId?: string;
    message?: Message;
    onClose?: () => void;
    modal?: boolean;
}) {
    const { records, setRecords, previewUrls, refresh } = useEmojiLibrary();
    const [status, setStatus] = useState("");
    const [query, setQuery] = useState("");
    const [activeTab, setActiveTab] = useState<"all" | "saved" | "unicode" | "custom">("all");
    const inputRef = useRef<HTMLInputElement>(null);

    const normalizedQuery = query.trim().toLocaleLowerCase();
    const filteredRecords = useMemo(
        () => records.filter(record => !normalizedQuery || record.name.toLocaleLowerCase().includes(normalizedQuery)),
        [normalizedQuery, records]
    );
    const nativeChoices = useMemo(
        () =>
            getNativeEmojiChoices(query, channelId, activeTab === "custom").filter(choice =>
                activeTab === "unicode" ? choice.kind === "unicode" : activeTab === "custom" ? choice.kind === "custom" : true
            ),
        [activeTab, channelId, query]
    );

    async function handleImport(file: File | undefined) {
        if (!file) return;
        try {
            const record = await importEmoji(file);
            setRecords(await readRecords());
            refresh();
            setStatus(`${record.name} saved locally. Use Attach to place it in chat.`);
        } catch (error) {
            setStatus(error instanceof Error ? error.message : "Could not import that image.");
        }
    }

    const showSaved = activeTab === "all" || activeTab === "saved";
    const showNative = activeTab !== "saved";

    return (
        <div className={modal ? "dmemoji-modal" : "dmemoji-settings"}>
            <div className="dmemoji-hero">
                <div>
                    <span className="dmemoji-kicker">DMEMOJI</span>
                    <h2>{message ? "React with any emoji" : "Your emoji drawer"}</h2>
                    <p>
                        {message
                            ? "Search Discord's native emoji and react in one click. Local files can also be linked to a real server emoji."
                            : "Native emoji insert into the composer. Your imported images and GIFs stay private to this client until you attach them."}
                    </p>
                    <span className="dmemoji-hero-note">
                        Custom emoji lists up to 240 server emoji available to this account. Browse iEmoji for a larger discovery catalog; only real Discord server emoji can be native reactions.
                    </span>
                </div>
                <div className="dmemoji-hero-actions">
                    <Button size={Button.Sizes.SMALL} color={Button.Colors.BRAND} onClick={() => inputRef.current?.click()}>
                        Import media
                    </Button>
                    <button
                        type="button"
                        className="dmemoji-external-link"
                        onClick={() => VencordNative.native.openExternal(IEMOJI_KEYBOARD_URL)}
                    >
                        Browse iEmoji library ↗
                    </button>
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
            </div>

            <div className="dmemoji-search-row">
                <input
                    className="dmemoji-search"
                    type="search"
                    value={query}
                    placeholder="Search shrug, party, cat, or a server emoji"
                    onChange={event => setQuery(event.currentTarget.value)}
                />
                <div className="dmemoji-tabs" role="tablist" aria-label="Emoji source">
                    {(["all", "saved", "unicode", "custom"] as const).map(tab => (
                        <button
                            type="button"
                            key={tab}
                            className={`dmemoji-tab ${activeTab === tab ? "is-active" : ""}`}
                            onClick={() => setActiveTab(tab)}
                            role="tab"
                            aria-selected={activeTab === tab}
                        >
                            {tab === "all" ? "All" : tab === "saved" ? "Saved media" : tab === "unicode" ? "Unicode" : "Custom emoji"}
                        </button>
                    ))}
                </div>
            </div>

            {status && <Forms.FormText className="dmemoji-status">{status}</Forms.FormText>}

            {showSaved && (
                <section className="dmemoji-section">
                    <div className="dmemoji-section-heading">
                        <div>
                            <h3>Saved media</h3>
                            <span>Private images and GIFs you can attach to the current message.</span>
                        </div>
                        <span className="dmemoji-count">{filteredRecords.length}</span>
                    </div>
                    {filteredRecords.length ? (
                        <div className="dmemoji-grid">
                            {filteredRecords.map(record => (
                                <LocalEmojiEntry
                                    key={record.id}
                                    record={record}
                                    previewUrl={previewUrls[record.id]}
                                    channelId={channelId}
                                    message={message}
                                    modal={modal}
                                    onClose={onClose}
                                    onRecordsChange={setRecords}
                                    onRefresh={refresh}
                                />
                            ))}
                        </div>
                    ) : (
                        <div className="dmemoji-empty">Nothing saved here yet. Import a PNG, JPG, GIF, or WebP.</div>
                    )}
                </section>
            )}

            {showNative && (
                <section className="dmemoji-section">
                    <div className="dmemoji-section-heading">
                        <div>
                            <h3>{activeTab === "custom" ? "Custom server emoji" : activeTab === "unicode" ? "Unicode emoji" : "Native emoji"}</h3>
                            <span>
                                {activeTab === "custom"
                                    ? "These are real Discord emoji from servers your account can use."
                                    : message
                                      ? "Click React to react to the selected message."
                                      : "Click Insert to place it in the message composer."}
                            </span>
                        </div>
                        <span className="dmemoji-count">{nativeChoices.length}</span>
                    </div>
                    {nativeChoices.length ? (
                        <div className="dmemoji-native-grid">
                            {nativeChoices.map(choice => (
                                <NativeEmojiCard key={choice.key} choice={choice} message={message} onClose={onClose} />
                            ))}
                        </div>
                    ) : (
                        <div className="dmemoji-empty">
                            Native emoji are still loading, or nothing matched. Try “shrug” or select Custom emoji.
                        </div>
                    )}
                </section>
            )}

            <div className="dmemoji-footnote">
                <strong>What can react?</strong> Unicode and real Discord server emoji can react natively. Imported local media is an attachment unless you link it to a server emoji identity; Discord does not accept an arbitrary local file as a reaction.
            </div>
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
                            <button type="button" className="dmemoji-close-btn" onClick={onClose} aria-label="Close">
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

function EmojiPickerModal(props: RenderModalProps & { channelId: string; message?: Message; }) {
    return (
        <ErrorBoundary message="Could not display DMEmoji picker">
            <SafeModalContainer transitionState={props.transitionState} onClose={props.onClose}>
                <EmojiLibrary channelId={props.channelId} message={props.message} onClose={props.onClose} modal />
            </SafeModalContainer>
        </ErrorBoundary>
    );
}

function isVisibleComposerElement(element: HTMLElement): boolean {
    if (element.getAttribute("aria-hidden") === "true") return false;
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && rect.width > 0 && rect.height > 0;
}

function composerText(input: HTMLElement): string {
    if (input instanceof HTMLTextAreaElement) return input.value;
    return (input.innerText ?? input.textContent ?? "").replace(/\u200b/g, "");
}

function findComposerSubmitButton(input: HTMLElement): HTMLElement | undefined {
    const scopes = [
        input.closest("form"),
        input.closest('[class*="channelTextArea" i]'),
        input.parentElement,
        document
    ].filter((scope, index, all): scope is Document | HTMLElement => Boolean(scope) && all.indexOf(scope) === index);
    const seen = new Set<HTMLElement>();

    for (const scope of scopes) {
        const candidates = Array.from(scope.querySelectorAll<HTMLElement>('button, [role="button"], input[type="submit"]'));
        for (const element of candidates) {
            if (seen.has(element) || element.hasAttribute("data-dmemoji-send-button") || !isVisibleComposerElement(element)) continue;
            seen.add(element);
            const label = [element.id, element.getAttribute("aria-label"), element.getAttribute("title"), element.getAttribute("data-testid")]
                .filter(Boolean)
                .join(" ")
                .toLowerCase();
            if (
                element.id === "submit-button" ||
                element.getAttribute("type") === "submit" ||
                label.includes("submit-button") ||
                /\bsend(?: message)?\b/.test(label)
            ) {
                return element;
            }
        }
    }

    return undefined;
}

async function sendCurrentMessage() {
    const inputs = Array.from(
        document.querySelectorAll<HTMLElement>('[role="textbox"][contenteditable="true"], [contenteditable="true"], textarea')
    )
        .filter(isVisibleComposerElement)
        .map(element => {
            const label = [element.getAttribute("aria-label"), element.getAttribute("placeholder")].filter(Boolean).join(" ").toLowerCase();
            return { element, score: /message|chat|reply|type/.test(label) ? 10 : 0 };
        })
        .sort((a, b) => b.score - a.score);

    const input = inputs[0]?.element;
    if (!input) {
        Toasts.show({ message: "Could not find the active message composer", id: Toasts.genId(), type: Toasts.Type.FAILURE });
        return;
    }

    const sendButton = findComposerSubmitButton(input);

    if (sendButton) {
        if (sendButton.getAttribute("aria-disabled") === "true" || (sendButton as HTMLButtonElement).disabled) {
            Toasts.show({ message: "There is no message ready to send", id: Toasts.genId(), type: Toasts.Type.FAILURE });
            return;
        }
        sendButton.click();
        return;
    }

    const composer = input.closest("form");
    if (composer && typeof composer.requestSubmit === "function") {
        composer.requestSubmit();
        return;
    }

    const content = composerText(input);
    if (!content.trim()) {
        Toasts.show({ message: "Type a message first", id: Toasts.genId(), type: Toasts.Type.FAILURE });
        return;
    }

    // Some Discord builds expose neither the submit button nor a form. A
    // synthetic KeyboardEvent does not reliably reach React's internal
    // composer handler, so use Discord's own send pipeline as the final
    // fallback. This preserves the normal channel and pending-reply route.
    const channelId = SelectedChannelStore.getChannelId();
    if (!channelId) {
        Toasts.show({ message: "Could not find the active message channel", id: Toasts.genId(), type: Toasts.Type.FAILURE });
        return;
    }

    try {
        const pendingReply = PendingReplyStore.getPendingReply(channelId);
        const replyOptions = pendingReply ? MessageActions.getSendMessageOptionsForReply(pendingReply) : undefined;
        await sendMessage(channelId, { content }, true, replyOptions);
        Toasts.show({ message: "Message sent", id: Toasts.genId(), type: Toasts.Type.SUCCESS });
    } catch (error) {
        console.error("[DMEmoji] Could not send message", error);
        Toasts.show({ message: "Discord could not send that message", id: Toasts.genId(), type: Toasts.Type.FAILURE });
    }
}

const DMEmojiButton: ChatBarButtonFactory = ({ isAnyChat, channel }) => {
    const { showButton, showSendButton } = settings.use(["showButton", "showSendButton"]);
    const channelId = channel?.id;
    if (!isAnyChat || !channelId || (!showButton && !showSendButton)) return null;
    return (
        <>
            {showButton && (
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
            )}
            {showSendButton && (
                <ChatBarButton
                    tooltip="Send message"
                    onClick={() => void sendCurrentMessage()}
                    buttonProps={{ "data-dmemoji-send-button": "true" }}
                >
                    <SendMessageIcon />
                </ChatBarButton>
            )}
        </>
    );
};

const messageContextMenuPatch: NavContextMenuPatchCallback = (children, props: { message?: Message; }) => {
    const message = props?.message;
    if (!message || !Array.isArray(children)) return;

    try {
        children.push(
            <Menu.MenuItem id="dmemoji-message-actions" label="DMEmoji">
                <Menu.MenuItem
                    id="dmemoji-open-reaction-picker"
                    label="Search and react..."
                    action={() =>
                        openModal(modalProps => (
                            <EmojiPickerModal {...modalProps} channelId={message.channel_id} message={message} />
                        ))
                    }
                />
                {emojiRecordsCache.length > 0 && (
                    <Menu.MenuItem id="dmemoji-local-actions" label="Saved media">
                        {emojiRecordsCache.map(record => {
                            const nativeEmoji = parseDiscordEmojiRef(record.discordEmojiRef, record.name);
                            return (
                                <Menu.MenuItem id={`dmemoji-actions-${record.id}`} key={record.id} label={record.name}>
                                    <Menu.MenuItem
                                        id={`dmemoji-send-${record.id}`}
                                        label="Attach image"
                                        action={() => void sendEmojiAsImage(record, message.channel_id)}
                                    />
                                    <Menu.MenuItem
                                        id={`dmemoji-react-${record.id}`}
                                        label={nativeEmoji ? "React with linked server emoji" : "Link a server emoji first"}
                                        disabled={!nativeEmoji}
                                        action={() => reactWithEmoji(message, record)}
                                    />
                                </Menu.MenuItem>
                            );
                        })}
                    </Menu.MenuItem>
                )}
            </Menu.MenuItem>
        );
    } catch (error) {
        console.warn("[DMEmoji] Could not add the message context menu", error);
    }
};

const settings = definePluginSettings({
    showButton: {
        type: OptionType.BOOLEAN,
        description: "Show the DMEmoji button beside the message composer",
        default: true
    },
    showSendButton: {
        type: OptionType.BOOLEAN,
        description: "Show a mouse-click Send button beside DMEmoji",
        default: true
    },
    library: {
        type: OptionType.COMPONENT,
        description: "Manage saved media and link images to native Discord emoji",
        component: () => <EmojiLibrary />
    }
});

export default definePlugin({
    name: "DMEmoji",
    description:
        "Search and insert Unicode/server emoji, react from a searchable picker, keep a private local media shelf, and send messages with a mouse-click button beside DMEmoji.",
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
