import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getBuiltinPlatform, mergePlatformRegistry } from "./platforms/registry.js";
import type {
  AdapterKind,
  ApiKeyRecord,
  AutomationPlug,
  ChannelAnalyticsSnapshot,
  ChannelConfig,
  ChannelConnection,
  ChannelsFileDocument,
  ExistingReceipt,
  FollowUpComment,
  GroupConfig,
  JobStatus,
  PlatformDefinition,
  PostingSet,
  PublishAttempt,
  PublishJob,
  PublishJobPayload,
  PublishingManifest,
  RssFeedRecord,
  SessionCheckResult,
  SignatureRecord,
  VideoAnalyticsMetric,
  WebhookDelivery,
  WebhookSubscription,
} from "./types.js";

const TERMINAL_DONE_STATUSES = new Set<JobStatus>(["scheduled", "published"]);

export function computeFileSha256(filePath: string): Promise<string> {
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("error", rejectHash);
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

export function hashSecret(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export interface UpsertChannelInput {
  id: string;
  name: string;
  groupId?: string;
  timezone?: string;
  defaultPostTime?: string;
  profileDir?: string;
}

export interface UpsertConnectionInput {
  id?: string;
  channelId: string;
  platform: string;
  handle: string;
  enabled?: boolean;
  adapter?: AdapterKind;
  customLoginUrl?: string;
  customComposeUrl?: string;
  customAnalyticsUrl?: string;
  webhookUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface EnqueueJobInput {
  idempotencyKey?: string;
  channelId: string;
  videoId?: string;
  currentVersionId?: string;
  episode?: string;
  title: string;
  platform: string;
  handle?: string;
  adapter?: AdapterKind;
  targetDate: string;
  publishAt: string;
  publishNowIfPastSlot?: boolean;
  videoPath?: string;
  videoSha256?: string;
  videoBytes?: number;
  coverPath?: string;
  coverSha256?: string;
  status?: JobStatus;
  payload?: PublishJobPayload;
}

export class VesperaStore {
  readonly db: DatabaseSync;

  constructor(
    dbPath: string,
    private readonly profilesDir: string,
  ) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS platform_definitions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        short_code TEXT NOT NULL,
        category TEXT NOT NULL,
        accent_hex TEXT NOT NULL,
        login_url TEXT NOT NULL,
        compose_url TEXT NOT NULL,
        analytics_url TEXT,
        featured_order INTEGER,
        supports_video INTEGER NOT NULL DEFAULT 1,
        supports_scheduling INTEGER NOT NULL DEFAULT 0,
        supports_subreddit INTEGER NOT NULL DEFAULT 0,
        supports_custom_thumbnail INTEGER NOT NULL DEFAULT 0,
        supports_first_comment INTEGER NOT NULL DEFAULT 0,
        auth_modes_json TEXT NOT NULL,
        notes TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        group_id TEXT,
        timezone TEXT NOT NULL,
        default_post_time TEXT NOT NULL,
        profile_dir TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS channel_connections (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        handle TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        adapter TEXT NOT NULL DEFAULT 'edge_studio',
        custom_login_url TEXT,
        custom_compose_url TEXT,
        custom_analytics_url TEXT,
        webhook_url TEXT,
        session_status TEXT NOT NULL DEFAULT 'unconnected',
        observed_handle TEXT,
        last_checked_at TEXT,
        evidence_file TEXT,
        session_note TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(channel_id, platform, handle),
        FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        channel_id TEXT NOT NULL,
        video_id TEXT NOT NULL,
        current_version_id TEXT NOT NULL,
        episode TEXT NOT NULL,
        title TEXT NOT NULL,
        platform TEXT NOT NULL,
        handle TEXT NOT NULL,
        adapter TEXT NOT NULL,
        target_date TEXT NOT NULL,
        publish_at TEXT NOT NULL,
        publish_now_if_past_slot INTEGER NOT NULL DEFAULT 1,
        video_path TEXT NOT NULL,
        video_sha256 TEXT NOT NULL,
        video_bytes INTEGER NOT NULL DEFAULT 0,
        cover_path TEXT,
        cover_sha256 TEXT,
        status TEXT NOT NULL,
        remote_id TEXT,
        remote_url TEXT,
        last_error TEXT,
        evidence_paths_json TEXT NOT NULL DEFAULT '[]',
        attempts_count INTEGER NOT NULL DEFAULT 0,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        executed_at TEXT,
        FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        adapter TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        outcome TEXT NOT NULL,
        remote_id TEXT,
        remote_url TEXT,
        screenshot_file TEXT,
        message TEXT NOT NULL,
        FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS follow_up_comments (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        comment_text TEXT NOT NULL,
        due_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        posted_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS posting_sets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        timezone TEXT NOT NULL,
        slots_json TEXT NOT NULL,
        platforms_json TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS signatures (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        channel_id TEXT,
        platform TEXT,
        body TEXT NOT NULL,
        auto_append INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS automation_plugs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        scope TEXT NOT NULL,
        channel_id TEXT,
        trigger_type TEXT NOT NULL,
        action_type TEXT NOT NULL,
        config_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_run_at TEXT,
        runs_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rss_feeds (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        feed_url TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        platforms_json TEXT NOT NULL,
        auto_publish INTEGER NOT NULL DEFAULT 0,
        default_time TEXT NOT NULL DEFAULT '10:00',
        last_checked_at TEXT,
        last_guid TEXT,
        last_error TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS webhooks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        target_url TEXT NOT NULL,
        secret TEXT NOT NULL,
        events_json TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_status INTEGER,
        last_delivered_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id TEXT PRIMARY KEY,
        webhook_id TEXT NOT NULL,
        event TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        response_status INTEGER,
        response_body TEXT,
        delivered_at TEXT NOT NULL,
        FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_used_at TEXT
      );

      CREATE TABLE IF NOT EXISTS analytics_channel_snapshots (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        followers INTEGER,
        total_views INTEGER,
        total_likes INTEGER,
        total_videos INTEGER,
        note TEXT,
        raw_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS analytics_video_metrics (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        remote_id TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT,
        published_at TEXT,
        views INTEGER NOT NULL DEFAULT 0,
        likes INTEGER NOT NULL DEFAULT 0,
        comments INTEGER NOT NULL DEFAULT 0,
        shares INTEGER NOT NULL DEFAULT 0,
        saves INTEGER NOT NULL DEFAULT 0,
        avg_watch_seconds REAL,
        retention_pct REAL,
        engagement_rate REAL NOT NULL DEFAULT 0,
        captured_at TEXT NOT NULL,
        UNIQUE(channel_id, platform, remote_id)
      );

      CREATE TABLE IF NOT EXISTS oauth_tokens (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        platform TEXT NOT NULL,
        account_label TEXT,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        scope TEXT,
        expires_at TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(channel_id, platform),
        FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_channel_date ON jobs(channel_id, target_date);
      CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, publish_at);
      CREATE INDEX IF NOT EXISTS idx_metrics_channel_views ON analytics_video_metrics(channel_id, views DESC);
    `);
  }

  // ---------------- Platforms ----------------

  listCustomPlatforms(): PlatformDefinition[] {
    const rows = this.db.prepare("SELECT * FROM platform_definitions ORDER BY name ASC").all() as Record<string, unknown>[];
    return rows.map(row => ({
      id: String(row.id),
      name: String(row.name),
      shortCode: String(row.short_code),
      category: String(row.category) as PlatformDefinition["category"],
      accentHex: String(row.accent_hex),
      loginUrl: String(row.login_url),
      composeUrl: String(row.compose_url),
      analyticsUrl: row.analytics_url ? String(row.analytics_url) : undefined,
      featuredOrder: typeof row.featured_order === "number" ? row.featured_order : undefined,
      supportsVideo: Boolean(row.supports_video),
      supportsScheduling: Boolean(row.supports_scheduling),
      supportsSubreddit: Boolean(row.supports_subreddit),
      supportsCustomThumbnail: Boolean(row.supports_custom_thumbnail),
      supportsFirstComment: Boolean(row.supports_first_comment),
      authModes: safeJsonParse<AdapterKind[]>(String(row.auth_modes_json ?? "[]"), ["edge_studio"]),
      builtIn: false,
      notes: row.notes ? String(row.notes) : undefined,
      createdAt: String(row.created_at),
    }));
  }

  listAllPlatforms(): PlatformDefinition[] {
    return mergePlatformRegistry(this.listCustomPlatforms());
  }

  getPlatformDefinition(id: string): PlatformDefinition | undefined {
    const cleanId = id.trim().toLowerCase();
    const custom = this.listCustomPlatforms().find(p => p.id === cleanId);
    return custom ?? getBuiltinPlatform(cleanId);
  }

  upsertCustomPlatform(input: {
    id: string;
    name: string;
    shortCode?: string;
    accentHex?: string;
    loginUrl: string;
    composeUrl?: string;
    analyticsUrl?: string;
    supportsVideo?: boolean;
    supportsScheduling?: boolean;
    supportsSubreddit?: boolean;
    supportsCustomThumbnail?: boolean;
    supportsFirstComment?: boolean;
    authModes?: AdapterKind[];
    notes?: string;
  }): PlatformDefinition {
    const cleanId = input.id.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
    if (!cleanId) throw new Error("Platform id must contain alphanumeric characters.");
    const existing = this.getPlatformDefinition(cleanId);
    const now = new Date().toISOString();
    const def: PlatformDefinition = {
      id: cleanId,
      name: input.name.trim(),
      shortCode: (input.shortCode?.trim() || input.name.trim().slice(0, 2)).toUpperCase(),
      category: "custom",
      accentHex: input.accentHex?.trim() || "#6366F1",
      loginUrl: input.loginUrl.trim(),
      composeUrl: (input.composeUrl ?? input.loginUrl).trim(),
      analyticsUrl: input.analyticsUrl?.trim() || undefined,
      featuredOrder: existing?.featuredOrder ?? 50,
      supportsVideo: input.supportsVideo ?? true,
      supportsScheduling: input.supportsScheduling ?? false,
      supportsSubreddit: input.supportsSubreddit ?? false,
      supportsCustomThumbnail: input.supportsCustomThumbnail ?? false,
      supportsFirstComment: input.supportsFirstComment ?? false,
      authModes: input.authModes?.length ? input.authModes : ["edge_studio", "custom_web", "webhook"],
      builtIn: false,
      notes: input.notes?.trim() || undefined,
      createdAt: existing?.createdAt ?? now,
    };

    this.db.prepare(`
      INSERT INTO platform_definitions (
        id, name, short_code, category, accent_hex, login_url, compose_url, analytics_url,
        featured_order, supports_video, supports_scheduling, supports_subreddit,
        supports_custom_thumbnail, supports_first_comment, auth_modes_json, notes, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        short_code = excluded.short_code,
        category = excluded.category,
        accent_hex = excluded.accent_hex,
        login_url = excluded.login_url,
        compose_url = excluded.compose_url,
        analytics_url = excluded.analytics_url,
        featured_order = excluded.featured_order,
        supports_video = excluded.supports_video,
        supports_scheduling = excluded.supports_scheduling,
        supports_subreddit = excluded.supports_subreddit,
        supports_custom_thumbnail = excluded.supports_custom_thumbnail,
        supports_first_comment = excluded.supports_first_comment,
        auth_modes_json = excluded.auth_modes_json,
        notes = excluded.notes
    `).run(
      def.id,
      def.name,
      def.shortCode,
      def.category,
      def.accentHex,
      def.loginUrl,
      def.composeUrl,
      def.analyticsUrl ?? null,
      def.featuredOrder ?? null,
      def.supportsVideo ? 1 : 0,
      def.supportsScheduling ? 1 : 0,
      def.supportsSubreddit ? 1 : 0,
      def.supportsCustomThumbnail ? 1 : 0,
      def.supportsFirstComment ? 1 : 0,
      JSON.stringify(def.authModes),
      def.notes ?? null,
      def.createdAt,
    );
    return def;
  }

  deleteCustomPlatform(id: string): boolean {
    const res = this.db.prepare("DELETE FROM platform_definitions WHERE id = ?").run(id);
    return Number(res.changes ?? 0) > 0;
  }

  // ---------------- Groups ----------------

  listGroups(): GroupConfig[] {
    const rows = this.db.prepare("SELECT * FROM groups ORDER BY name ASC").all() as Record<string, unknown>[];
    return rows.map(r => ({
      id: String(r.id),
      name: String(r.name),
      color: String(r.color),
      createdAt: String(r.created_at),
    }));
  }

  upsertGroup(input: { id: string; name: string; color?: string }): GroupConfig {
    const cleanId = input.id.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
    const now = new Date().toISOString();
    const color = input.color?.trim() || "#6366F1";
    this.db.prepare(`
      INSERT INTO groups (id, name, color, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, color = excluded.color
    `).run(cleanId, input.name.trim(), color, now);
    return { id: cleanId, name: input.name.trim(), color, createdAt: now };
  }

  deleteGroup(id: string): boolean {
    this.db.prepare("UPDATE channels SET group_id = NULL WHERE group_id = ?").run(id);
    const res = this.db.prepare("DELETE FROM groups WHERE id = ?").run(id);
    return Number(res.changes ?? 0) > 0;
  }

  // ---------------- Channels & Connections ----------------

  private mapConnection(row: Record<string, unknown>): ChannelConnection {
    return {
      id: String(row.id),
      channelId: String(row.channel_id),
      platform: String(row.platform),
      handle: String(row.handle),
      enabled: Boolean(row.enabled),
      adapter: String(row.adapter) as AdapterKind,
      customLoginUrl: row.custom_login_url ? String(row.custom_login_url) : undefined,
      customComposeUrl: row.custom_compose_url ? String(row.custom_compose_url) : undefined,
      customAnalyticsUrl: row.custom_analytics_url ? String(row.custom_analytics_url) : undefined,
      webhookUrl: row.webhook_url ? String(row.webhook_url) : undefined,
      sessionStatus: String(row.session_status) as ChannelConnection["sessionStatus"],
      observedHandle: row.observed_handle ? String(row.observed_handle) : undefined,
      lastCheckedAt: row.last_checked_at ? String(row.last_checked_at) : undefined,
      evidenceFile: row.evidence_file ? String(row.evidence_file) : undefined,
      sessionNote: row.session_note ? String(row.session_note) : undefined,
      metadata: safeJsonParse<Record<string, unknown>>(String(row.metadata_json ?? "{}"), {}),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  listChannels(): ChannelConfig[] {
    const channelRows = this.db.prepare("SELECT * FROM channels ORDER BY name ASC").all() as Record<string, unknown>[];
    const connRows = this.db
      .prepare("SELECT * FROM channel_connections ORDER BY platform ASC, handle ASC")
      .all() as Record<string, unknown>[];
    const connByChannel = new Map<string, ChannelConnection[]>();
    for (const row of connRows) {
      const mapped = this.mapConnection(row);
      const list = connByChannel.get(mapped.channelId) ?? [];
      list.push(mapped);
      connByChannel.set(mapped.channelId, list);
    }

    return channelRows.map(row => ({
      id: String(row.id),
      name: String(row.name),
      groupId: row.group_id ? String(row.group_id) : undefined,
      timezone: String(row.timezone),
      defaultPostTime: String(row.default_post_time),
      profileDir: String(row.profile_dir),
      connections: connByChannel.get(String(row.id)) ?? [],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  getChannel(id: string): ChannelConfig | undefined {
    return this.listChannels().find(c => c.id === id);
  }

  getConnection(channelId: string, platformOrConnId: string): ChannelConnection | undefined {
    const channel = this.getChannel(channelId);
    if (!channel) return undefined;
    return channel.connections.find(c => c.id === platformOrConnId || c.platform === platformOrConnId);
  }

  upsertChannel(input: UpsertChannelInput): ChannelConfig {
    const cleanId = input.id.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
    if (!cleanId) throw new Error("Channel id must contain alphanumeric characters.");
    const existing = this.getChannel(cleanId);
    const now = new Date().toISOString();
    const profileDir = input.profileDir?.trim() || existing?.profileDir || join(this.profilesDir, cleanId);

    this.db.prepare(`
      INSERT INTO channels (id, name, group_id, timezone, default_post_time, profile_dir, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        group_id = excluded.group_id,
        timezone = excluded.timezone,
        default_post_time = excluded.default_post_time,
        profile_dir = excluded.profile_dir,
        updated_at = excluded.updated_at
    `).run(
      cleanId,
      input.name.trim(),
      input.groupId ?? existing?.groupId ?? null,
      input.timezone ?? existing?.timezone ?? "America/New_York",
      input.defaultPostTime ?? existing?.defaultPostTime ?? "10:00",
      profileDir,
      existing?.createdAt ?? now,
      now,
    );

    return this.getChannel(cleanId)!;
  }

  deleteChannel(id: string): boolean {
    const res = this.db.prepare("DELETE FROM channels WHERE id = ?").run(id);
    return Number(res.changes ?? 0) > 0;
  }

  upsertConnection(input: UpsertConnectionInput): ChannelConnection {
    const channel = this.getChannel(input.channelId);
    if (!channel) throw new Error(`Unknown channel '${input.channelId}'`);

    const platform = input.platform.trim().toLowerCase();
    const handle = input.handle.trim() || "@account";
    const now = new Date().toISOString();

    const existing = this.db
      .prepare("SELECT * FROM channel_connections WHERE id = ? OR (channel_id = ? AND platform = ? AND handle = ?)")
      .get(input.id ?? "", input.channelId, platform, handle) as Record<string, unknown> | undefined;

    const id = existing ? String(existing.id) : input.id ?? `${input.channelId}:${platform}:${randomUUID().slice(0, 8)}`;
    const enabled = input.enabled ?? (existing ? Boolean(existing.enabled) : true);
    const adapter = input.adapter ?? (existing ? (String(existing.adapter) as AdapterKind) : "edge_studio");

    this.db.prepare(`
      INSERT INTO channel_connections (
        id, channel_id, platform, handle, enabled, adapter,
        custom_login_url, custom_compose_url, custom_analytics_url, webhook_url,
        session_status, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        handle = excluded.handle,
        enabled = excluded.enabled,
        adapter = excluded.adapter,
        custom_login_url = excluded.custom_login_url,
        custom_compose_url = excluded.custom_compose_url,
        custom_analytics_url = excluded.custom_analytics_url,
        webhook_url = excluded.webhook_url,
        metadata_json = excluded.metadata_json,
        updated_at = excluded.updated_at
    `).run(
      id,
      input.channelId,
      platform,
      handle,
      enabled ? 1 : 0,
      adapter,
      input.customLoginUrl ?? (existing?.custom_login_url ? String(existing.custom_login_url) : null),
      input.customComposeUrl ?? (existing?.custom_compose_url ? String(existing.custom_compose_url) : null),
      input.customAnalyticsUrl ?? (existing?.custom_analytics_url ? String(existing.custom_analytics_url) : null),
      input.webhookUrl ?? (existing?.webhook_url ? String(existing.webhook_url) : null),
      existing ? String(existing.session_status) : "unconnected",
      JSON.stringify(input.metadata ?? (existing ? safeJsonParse(String(existing.metadata_json), {}) : {})),
      existing ? String(existing.created_at) : now,
      now,
    );

    const saved = this.db.prepare("SELECT * FROM channel_connections WHERE id = ?").get(id) as Record<string, unknown>;
    return this.mapConnection(saved);
  }

  updateConnectionFields(
    channelId: string,
    connId: string,
    patch: Partial<{
      handle: string;
      enabled: boolean;
      adapter: AdapterKind;
      customLoginUrl: string | null;
      customComposeUrl: string | null;
      customAnalyticsUrl: string | null;
      webhookUrl: string | null;
    }>,
  ): ChannelConnection | undefined {
    const channel = this.getChannel(channelId);
    if (!channel) return undefined;
    const conn = channel.connections.find(c => c.id === connId || c.platform === connId);
    if (!conn) return undefined;

    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE channel_connections SET
        handle = ?,
        enabled = ?,
        adapter = ?,
        custom_login_url = ?,
        custom_compose_url = ?,
        custom_analytics_url = ?,
        webhook_url = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      patch.handle ?? conn.handle,
      patch.enabled !== undefined ? (patch.enabled ? 1 : 0) : conn.enabled ? 1 : 0,
      patch.adapter ?? conn.adapter,
      patch.customLoginUrl === undefined ? conn.customLoginUrl ?? null : patch.customLoginUrl,
      patch.customComposeUrl === undefined ? conn.customComposeUrl ?? null : patch.customComposeUrl,
      patch.customAnalyticsUrl === undefined ? conn.customAnalyticsUrl ?? null : patch.customAnalyticsUrl,
      patch.webhookUrl === undefined ? conn.webhookUrl ?? null : patch.webhookUrl,
      now,
      conn.id,
    );

    const row = this.db.prepare("SELECT * FROM channel_connections WHERE id = ?").get(conn.id) as Record<string, unknown>;
    return this.mapConnection(row);
  }

  deleteConnection(channelId: string, connId: string): boolean {
    const res = this.db.prepare("DELETE FROM channel_connections WHERE channel_id = ? AND (id = ? OR platform = ?)").run(
      channelId,
      connId,
      connId,
    );
    return Number(res.changes ?? 0) > 0;
  }

  requeueNeedsLoginJobs(channelId: string, platform: string): number {
    const now = new Date().toISOString();
    const res = this.db
      .prepare(`
        UPDATE jobs SET status = 'queued', last_error = NULL, updated_at = ?
        WHERE channel_id = ? AND platform = ? AND status = 'needs_login'
      `)
      .run(now, channelId, platform);
    return Number(res.changes ?? 0);
  }

  saveSessionCheck(result: SessionCheckResult): void {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE channel_connections SET
        session_status = ?,
        observed_handle = ?,
        last_checked_at = ?,
        evidence_file = ?,
        session_note = ?,
        updated_at = ?
      WHERE channel_id = ? AND platform = ?
    `).run(
      result.status,
      result.observedHandle ?? null,
      result.checkedAt,
      result.screenshotFile ?? null,
      result.note ?? null,
      now,
      result.channelId,
      result.platform,
    );
    if (result.status === "signed_in") {
      const requeued = this.requeueNeedsLoginJobs(result.channelId, result.platform);
      if (requeued > 0) {
        console.log(`[auth] Re-queued ${requeued} needs_login job(s) for ${result.channelId}/${result.platform}`);
      }
    }
  }

  // ---------------- Jobs & Attempts ----------------

  private mapJob(row: Record<string, unknown>): PublishJob {
    return {
      id: String(row.id),
      idempotencyKey: String(row.idempotency_key),
      channelId: String(row.channel_id),
      videoId: String(row.video_id),
      currentVersionId: String(row.current_version_id),
      episode: String(row.episode),
      title: String(row.title),
      platform: String(row.platform),
      handle: String(row.handle),
      adapter: String(row.adapter) as AdapterKind,
      targetDate: String(row.target_date),
      publishAt: String(row.publish_at),
      publishNowIfPastSlot: Boolean(row.publish_now_if_past_slot),
      videoPath: String(row.video_path),
      videoSha256: String(row.video_sha256),
      videoBytes: Number(row.video_bytes ?? 0),
      coverPath: row.cover_path ? String(row.cover_path) : undefined,
      coverSha256: row.cover_sha256 ? String(row.cover_sha256) : undefined,
      status: String(row.status) as JobStatus,
      remoteId: row.remote_id ? String(row.remote_id) : undefined,
      remoteUrl: row.remote_url ? String(row.remote_url) : undefined,
      lastError: row.last_error ? String(row.last_error) : undefined,
      evidencePaths: safeJsonParse<string[]>(String(row.evidence_paths_json ?? "[]"), []),
      attemptsCount: Number(row.attempts_count ?? 0),
      payload: safeJsonParse<PublishJobPayload>(String(row.payload_json ?? "{}"), {}),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      executedAt: row.executed_at ? String(row.executed_at) : undefined,
    };
  }

  listJobs(filters?: { channelId?: string; platform?: string; status?: JobStatus }): PublishJob[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filters?.channelId) {
      clauses.push("channel_id = ?");
      params.push(filters.channelId);
    }
    if (filters?.platform) {
      clauses.push("platform = ?");
      params.push(filters.platform);
    }
    if (filters?.status) {
      clauses.push("status = ?");
      params.push(filters.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM jobs ${where} ORDER BY target_date ASC, publish_at ASC, created_at ASC`)
      .all(...params) as Record<string, unknown>[];
    return rows.map(r => this.mapJob(r));
  }

  getJob(id: string): PublishJob | undefined {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? this.mapJob(row) : undefined;
  }

  getJobByIdempotencyKey(key: string): PublishJob | undefined {
    const row = this.db.prepare("SELECT * FROM jobs WHERE idempotency_key = ?").get(key) as Record<string, unknown> | undefined;
    return row ? this.mapJob(row) : undefined;
  }

  saveJob(job: PublishJob): void {
    this.db.prepare(`
      INSERT INTO jobs (
        id, idempotency_key, channel_id, video_id, current_version_id, episode, title,
        platform, handle, adapter, target_date, publish_at, publish_now_if_past_slot,
        video_path, video_sha256, video_bytes, cover_path, cover_sha256, status,
        remote_id, remote_url, last_error, evidence_paths_json, attempts_count,
        payload_json, created_at, updated_at, executed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        platform = excluded.platform,
        handle = excluded.handle,
        adapter = excluded.adapter,
        target_date = excluded.target_date,
        publish_at = excluded.publish_at,
        publish_now_if_past_slot = excluded.publish_now_if_past_slot,
        video_path = excluded.video_path,
        video_sha256 = excluded.video_sha256,
        video_bytes = excluded.video_bytes,
        cover_path = excluded.cover_path,
        cover_sha256 = excluded.cover_sha256,
        status = excluded.status,
        remote_id = excluded.remote_id,
        remote_url = excluded.remote_url,
        last_error = excluded.last_error,
        evidence_paths_json = excluded.evidence_paths_json,
        attempts_count = excluded.attempts_count,
        payload_json = excluded.payload_json,
        updated_at = excluded.updated_at,
        executed_at = excluded.executed_at
    `).run(
      job.id,
      job.idempotencyKey,
      job.channelId,
      job.videoId,
      job.currentVersionId,
      job.episode,
      job.title,
      job.platform,
      job.handle,
      job.adapter,
      job.targetDate,
      job.publishAt,
      job.publishNowIfPastSlot ? 1 : 0,
      job.videoPath,
      job.videoSha256,
      job.videoBytes,
      job.coverPath ?? null,
      job.coverSha256 ?? null,
      job.status,
      job.remoteId ?? null,
      job.remoteUrl ?? null,
      job.lastError ?? null,
      JSON.stringify(job.evidencePaths),
      job.attemptsCount,
      JSON.stringify(job.payload),
      job.createdAt,
      job.updatedAt,
      job.executedAt ?? null,
    );
  }

  enqueueJob(input: EnqueueJobInput): { job: PublishJob; created: boolean } {
    const channel = this.getChannel(input.channelId);
    if (!channel) throw new Error(`Unknown channel '${input.channelId}'`);

    const conn = channel.connections.find(c => c.platform === input.platform);
    const idempotencyKey =
      input.idempotencyKey
      ?? `${input.channelId}:${input.videoId ?? input.title}:${input.platform}:${input.targetDate}`;

    const existing = this.getJobByIdempotencyKey(idempotencyKey);
    if (existing) return { job: existing, created: false };

    const now = new Date().toISOString();
    const job: PublishJob = {
      id: randomUUID(),
      idempotencyKey,
      channelId: input.channelId,
      videoId: input.videoId ?? randomUUID(),
      currentVersionId: input.currentVersionId ?? "v1",
      episode: input.episode ?? input.targetDate,
      title: input.title,
      platform: input.platform,
      handle: input.handle ?? conn?.handle ?? "@account",
      adapter: input.adapter ?? conn?.adapter ?? "edge_studio",
      targetDate: input.targetDate,
      publishAt: input.publishAt,
      publishNowIfPastSlot: input.publishNowIfPastSlot ?? true,
      videoPath: input.videoPath ?? "",
      videoSha256: input.videoSha256 ?? "",
      videoBytes: input.videoBytes ?? 0,
      coverPath: input.coverPath,
      coverSha256: input.coverSha256,
      status: input.status ?? "queued",
      evidencePaths: [],
      attemptsCount: 0,
      payload: input.payload ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.saveJob(job);
    return { job, created: true };
  }

  updateJob(
    id: string,
    patch: Partial<{
      title: string;
      status: JobStatus;
      targetDate: string;
      publishAt: string;
      publishNowIfPastSlot: boolean;
      payload: PublishJobPayload;
      lastError: string | null;
    }>,
  ): PublishJob | undefined {
    const job = this.getJob(id);
    if (!job) return undefined;
    const updated: PublishJob = {
      ...job,
      title: patch.title ?? job.title,
      status: patch.status ?? job.status,
      targetDate: patch.targetDate ?? job.targetDate,
      publishAt: patch.publishAt ?? job.publishAt,
      publishNowIfPastSlot: patch.publishNowIfPastSlot ?? job.publishNowIfPastSlot,
      payload: patch.payload ? { ...job.payload, ...patch.payload } : job.payload,
      lastError: patch.lastError === undefined ? job.lastError : patch.lastError ?? undefined,
      updatedAt: new Date().toISOString(),
    };
    this.saveJob(updated);
    return updated;
  }

  deleteJob(id: string): boolean {
    const res = this.db.prepare("DELETE FROM jobs WHERE id = ?").run(id);
    return Number(res.changes ?? 0) > 0;
  }

  recordAttempt(attempt: Omit<PublishAttempt, "id">): PublishAttempt {
    const record: PublishAttempt = { id: randomUUID(), ...attempt };
    this.db.prepare(`
      INSERT INTO attempts (id, job_id, adapter, started_at, finished_at, outcome, remote_id, remote_url, screenshot_file, message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.jobId,
      record.adapter,
      record.startedAt,
      record.finishedAt,
      record.outcome,
      record.remoteId ?? null,
      record.remoteUrl ?? null,
      record.screenshotFile ?? null,
      record.message,
    );
    return record;
  }

  listAttempts(jobId?: string): PublishAttempt[] {
    const rows = (jobId
      ? this.db.prepare("SELECT * FROM attempts WHERE job_id = ? ORDER BY started_at DESC").all(jobId)
      : this.db.prepare("SELECT * FROM attempts ORDER BY started_at DESC LIMIT 200").all()) as Record<string, unknown>[];
    return rows.map(row => ({
      id: String(row.id),
      jobId: String(row.job_id),
      adapter: String(row.adapter) as AdapterKind,
      startedAt: String(row.started_at),
      finishedAt: String(row.finished_at),
      outcome: String(row.outcome) as PublishAttempt["outcome"],
      remoteId: row.remote_id ? String(row.remote_id) : undefined,
      remoteUrl: row.remote_url ? String(row.remote_url) : undefined,
      screenshotFile: row.screenshot_file ? String(row.screenshot_file) : undefined,
      message: String(row.message),
    }));
  }

  async verifyMediaIntegrity(job: PublishJob): Promise<{ ok: boolean; reason?: string }> {
    if (!job.videoPath) {
      return { ok: true };
    }
    if (!existsSync(job.videoPath)) {
      return { ok: false, reason: `Missing video file: ${job.videoPath}` };
    }
    if (job.videoSha256) {
      const videoHash = await computeFileSha256(job.videoPath);
      if (videoHash.toLowerCase() !== job.videoSha256.toLowerCase()) {
        return {
          ok: false,
          reason: `Video SHA-256 mismatch (expected ${job.videoSha256}, observed ${videoHash})`,
        };
      }
    }
    if (job.coverPath && job.coverSha256) {
      if (!existsSync(job.coverPath)) {
        return { ok: false, reason: `Missing cover file: ${job.coverPath}` };
      }
      const coverHash = await computeFileSha256(job.coverPath);
      if (coverHash.toLowerCase() !== job.coverSha256.toLowerCase()) {
        return {
          ok: false,
          reason: `Cover SHA-256 mismatch (expected ${job.coverSha256}, observed ${coverHash})`,
        };
      }
    }
    return { ok: true };
  }

  listRunnableJobs(
    nowIso = new Date().toISOString(),
    filters?: { channelId?: string; platform?: string; jobId?: string },
  ): PublishJob[] {
    const nowMs = Date.parse(nowIso);
    if (!Number.isFinite(nowMs)) return [];
    const channelsById = new Map(this.listChannels().map(c => [c.id, c]));
    return this.listJobs({
      channelId: filters?.channelId,
      platform: filters?.platform,
      status: "queued",
    }).filter(job => {
      if (filters?.jobId && job.id !== filters.jobId) return false;
      const channel = channelsById.get(job.channelId);
      const conn = channel?.connections.find(c => c.platform === job.platform);
      if (!conn?.enabled) return false;
      const publishMs = Date.parse(job.publishAt);
      if (!Number.isFinite(publishMs)) return false;
      return nowMs >= publishMs;
    });
  }

  countDueQueuedJobs(nowIso = new Date().toISOString()): number {
    return this.listRunnableJobs(nowIso).length;
  }

  countOverdueQueuedJobs(nowIso = new Date().toISOString()): number {
    const nowMs = Date.parse(nowIso);
    if (!Number.isFinite(nowMs)) return 0;
    const cutoff = nowMs - 60_000;
    return this.listRunnableJobs(nowIso).filter(job => {
      const publishMs = Date.parse(job.publishAt);
      return Number.isFinite(publishMs) && publishMs < cutoff;
    }).length;
  }

  recoverStaleRunningJobs(): PublishJob[] {
    const runningJobs = this.listJobs({ status: "running" });
    if (runningJobs.length === 0) return [];
    const now = new Date().toISOString();
    const message = "Server restarted while job was running; verify on platform before retrying.";
    const recovered: PublishJob[] = [];
    for (const job of runningJobs) {
      const updated: PublishJob = {
        ...job,
        status: "needs_human_action",
        lastError: message,
        updatedAt: now,
      };
      this.saveJob(updated);
      this.recordAttempt({
        jobId: job.id,
        adapter: job.adapter,
        startedAt: now,
        finishedAt: now,
        outcome: "needs_human_action",
        message,
      });
      recovered.push(updated);
    }
    return recovered;
  }

  listAllowedMediaRoots(): string[] {
    const roots = new Set<string>();
    for (const job of this.listJobs()) {
      if (job.videoPath) roots.add(resolve(dirname(job.videoPath)));
      if (job.coverPath) roots.add(resolve(dirname(job.coverPath)));
    }
    return Array.from(roots);
  }

  // ---------------- Channel Config & Manifest Importers ----------------

  importChannelsFile(filePath: string): { channels: number; connections: number } {
    if (!existsSync(filePath)) return { channels: 0, connections: 0 };
    const doc = JSON.parse(readFileSync(filePath, "utf8")) as ChannelsFileDocument;
    for (const group of doc.groups ?? []) {
      this.upsertGroup(group);
    }
    for (const customPlatform of doc.customPlatforms ?? []) {
      this.upsertCustomPlatform(customPlatform);
    }
    let connCount = 0;
    for (const ch of doc.channels ?? []) {
      this.upsertChannel({
        id: ch.id,
        name: ch.name,
        groupId: ch.groupId,
        timezone: ch.timezone,
        defaultPostTime: ch.defaultPostTime,
        profileDir: ch.profileDir,
      });
      for (const conn of ch.connections ?? []) {
        this.upsertConnection({
          channelId: ch.id,
          platform: conn.platform,
          handle: conn.handle,
          enabled: conn.enabled ?? true,
          adapter: conn.adapter ?? "edge_studio",
          customLoginUrl: conn.customLoginUrl,
          customComposeUrl: conn.customComposeUrl,
          customAnalyticsUrl: conn.customAnalyticsUrl,
          webhookUrl: conn.webhookUrl,
          metadata: conn.metadata,
        });
        connCount += 1;
      }
    }
    return { channels: doc.channels?.length ?? 0, connections: connCount };
  }

  importManifest(
    manifest: PublishingManifest,
    existingReceipts: ExistingReceipt[] = [],
  ): { totalJobs: number; created: number; reconciled: number; existing: number } {
    let created = 0;
    let reconciled = 0;
    let existingCount = 0;

    const receiptMap = new Map<string, ExistingReceipt>();
    for (const r of existingReceipts) {
      receiptMap.set(`${r.channelId}:${r.videoId}:${r.platform}:${r.targetDate}`, r);
    }

    for (const d of manifest.deliverables) {
      const channel = this.getChannel(d.channelId);
      if (!channel) {
        throw new Error(`Manifest references unknown channel '${d.channelId}'`);
      }

      for (const [platform, target] of Object.entries(d.platforms)) {
        if (!target) continue;
        const conn = channel.connections.find(c => c.platform === platform && c.enabled);
        if (!conn) continue;

        const key = `${d.channelId}:${d.videoId}:${platform}:${d.targetDate}`;
        const coverPath = target.coverPath ?? target.thumbnailPath ?? d.files.coverPath;
        const res = this.enqueueJob({
          idempotencyKey: key,
          channelId: d.channelId,
          videoId: d.videoId,
          currentVersionId: d.currentVersionId,
          episode: d.episode,
          title: d.title,
          platform,
          handle: conn.handle,
          adapter: conn.adapter,
          targetDate: d.targetDate,
          publishAt: target.scheduleAt ?? d.publishAtToronto,
          publishNowIfPastSlot: target.publishNowIfPastSlot ?? d.publishNowIfPastSlot ?? true,
          videoPath: d.files.videoPath,
          videoSha256: d.files.videoSha256,
          videoBytes: d.files.videoBytes,
          coverPath,
          coverSha256: d.files.coverSha256,
          payload: {
            title: target.title ?? d.title,
            description: target.description,
            caption: target.caption,
            postText: target.postText,
            hashtags: target.hashtags,
            subreddit: target.subreddit,
            madeForKids: target.madeForKids ?? false,
            aiDisclosure:
              target.alteredContentDisclosure ?? target.aiGeneratedDisclosure ?? target.aiLabel ?? true,
            method: target.method,
          },
        });

        let job = res.job;
        if (res.created) created += 1;
        else existingCount += 1;

        const matchedReceipt = receiptMap.get(key);
        if (matchedReceipt && job.status !== matchedReceipt.status && !TERMINAL_DONE_STATUSES.has(job.status)) {
          const now = new Date().toISOString();
          const screenshot = matchedReceipt.verifiedEvidence?.screenshot;
          job = {
            ...job,
            status: matchedReceipt.status,
            remoteId: matchedReceipt.remoteId ?? job.remoteId,
            remoteUrl: matchedReceipt.remoteUrl ?? job.remoteUrl,
            executedAt: matchedReceipt.publishedAtToronto ?? matchedReceipt.scheduledAtToronto ?? now,
            evidencePaths: screenshot ? Array.from(new Set([...job.evidencePaths, screenshot])) : job.evidencePaths,
            updatedAt: now,
          };
          this.saveJob(job);
          this.recordAttempt({
            jobId: job.id,
            adapter: job.adapter,
            startedAt: now,
            finishedAt: now,
            outcome: "reconciled_receipt",
            remoteId: job.remoteId,
            remoteUrl: job.remoteUrl,
            screenshotFile: screenshot,
            message: `Reconciled pre-existing ${matchedReceipt.status} receipt for ${job.handle}.`,
          });
          reconciled += 1;
        }
      }
    }

    return {
      totalJobs: this.listJobs().length,
      created,
      reconciled,
      existing: existingCount,
    };
  }

  // ---------------- Automations: Posting Sets, Signatures, Plugs, RSS, Webhooks, Comments ----------------

  listPostingSets(): PostingSet[] {
    const rows = this.db.prepare("SELECT * FROM posting_sets ORDER BY name ASC").all() as Record<string, unknown>[];
    return rows.map(r => ({
      id: String(r.id),
      name: String(r.name),
      timezone: String(r.timezone),
      slots: safeJsonParse(String(r.slots_json), []),
      platforms: safeJsonParse(String(r.platforms_json), []),
      active: Boolean(r.active),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }));
  }

  upsertPostingSet(input: Omit<PostingSet, "id" | "createdAt" | "updatedAt"> & { id?: string }): PostingSet {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO posting_sets (id, name, timezone, slots_json, platforms_json, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        timezone = excluded.timezone,
        slots_json = excluded.slots_json,
        platforms_json = excluded.platforms_json,
        active = excluded.active,
        updated_at = excluded.updated_at
    `).run(id, input.name, input.timezone, JSON.stringify(input.slots), JSON.stringify(input.platforms), input.active ? 1 : 0, now, now);
    return this.listPostingSets().find(s => s.id === id)!;
  }

  deletePostingSet(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM posting_sets WHERE id = ?").run(id).changes ?? 0) > 0;
  }

  listSignatures(): SignatureRecord[] {
    const rows = this.db.prepare("SELECT * FROM signatures ORDER BY name ASC").all() as Record<string, unknown>[];
    return rows.map(r => ({
      id: String(r.id),
      name: String(r.name),
      channelId: r.channel_id ? String(r.channel_id) : undefined,
      platform: r.platform ? String(r.platform) : undefined,
      body: String(r.body),
      autoAppend: Boolean(r.auto_append),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }));
  }

  upsertSignature(input: Omit<SignatureRecord, "id" | "createdAt" | "updatedAt"> & { id?: string }): SignatureRecord {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO signatures (id, name, channel_id, platform, body, auto_append, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        channel_id = excluded.channel_id,
        platform = excluded.platform,
        body = excluded.body,
        auto_append = excluded.auto_append,
        updated_at = excluded.updated_at
    `).run(id, input.name, input.channelId ?? null, input.platform ?? null, input.body, input.autoAppend ? 1 : 0, now, now);
    return this.listSignatures().find(s => s.id === id)!;
  }

  deleteSignature(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM signatures WHERE id = ?").run(id).changes ?? 0) > 0;
  }

  listPlugs(): AutomationPlug[] {
    const rows = this.db.prepare("SELECT * FROM automation_plugs ORDER BY name ASC").all() as Record<string, unknown>[];
    return rows.map(r => ({
      id: String(r.id),
      name: String(r.name),
      scope: String(r.scope) as AutomationPlug["scope"],
      channelId: r.channel_id ? String(r.channel_id) : undefined,
      triggerType: String(r.trigger_type) as AutomationPlug["triggerType"],
      actionType: String(r.action_type) as AutomationPlug["actionType"],
      config: safeJsonParse(String(r.config_json), {}),
      enabled: Boolean(r.enabled),
      lastRunAt: r.last_run_at ? String(r.last_run_at) : undefined,
      runsCount: Number(r.runs_count ?? 0),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }));
  }

  upsertPlug(input: Omit<AutomationPlug, "id" | "createdAt" | "updatedAt" | "runsCount"> & { id?: string }): AutomationPlug {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO automation_plugs (
        id, name, scope, channel_id, trigger_type, action_type, config_json, enabled, runs_count, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        scope = excluded.scope,
        channel_id = excluded.channel_id,
        trigger_type = excluded.trigger_type,
        action_type = excluded.action_type,
        config_json = excluded.config_json,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `).run(
      id,
      input.name,
      input.scope,
      input.channelId ?? null,
      input.triggerType,
      input.actionType,
      JSON.stringify(input.config ?? {}),
      input.enabled ? 1 : 0,
      now,
      now,
    );
    return this.listPlugs().find(p => p.id === id)!;
  }

  deletePlug(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM automation_plugs WHERE id = ?").run(id).changes ?? 0) > 0;
  }

  incrementPlugRun(id: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE automation_plugs SET runs_count = runs_count + 1, last_run_at = ?, updated_at = ? WHERE id = ?")
      .run(now, now, id);
  }

  listRssFeeds(): RssFeedRecord[] {
    const rows = this.db.prepare("SELECT * FROM rss_feeds ORDER BY name ASC").all() as Record<string, unknown>[];
    return rows.map(r => ({
      id: String(r.id),
      name: String(r.name),
      feedUrl: String(r.feed_url),
      channelId: String(r.channel_id),
      platforms: safeJsonParse(String(r.platforms_json), []),
      autoPublish: Boolean(r.auto_publish),
      defaultTime: String(r.default_time),
      lastCheckedAt: r.last_checked_at ? String(r.last_checked_at) : undefined,
      lastGuid: r.last_guid ? String(r.last_guid) : undefined,
      lastError: r.last_error ? String(r.last_error) : undefined,
      enabled: Boolean(r.enabled),
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }));
  }

  upsertRssFeed(input: Omit<RssFeedRecord, "id" | "createdAt" | "updatedAt"> & { id?: string }): RssFeedRecord {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO rss_feeds (
        id, name, feed_url, channel_id, platforms_json, auto_publish, default_time, enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        feed_url = excluded.feed_url,
        channel_id = excluded.channel_id,
        platforms_json = excluded.platforms_json,
        auto_publish = excluded.auto_publish,
        default_time = excluded.default_time,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `).run(
      id,
      input.name,
      input.feedUrl,
      input.channelId,
      JSON.stringify(input.platforms),
      input.autoPublish ? 1 : 0,
      input.defaultTime || "10:00",
      input.enabled ? 1 : 0,
      now,
      now,
    );
    return this.listRssFeeds().find(f => f.id === id)!;
  }

  updateRssFeedSync(id: string, patch: { lastCheckedAt: string; lastGuid?: string; lastError?: string | null }): void {
    this.db.prepare(`
      UPDATE rss_feeds SET last_checked_at = ?, last_guid = COALESCE(?, last_guid), last_error = ?, updated_at = ?
      WHERE id = ?
    `).run(patch.lastCheckedAt, patch.lastGuid ?? null, patch.lastError ?? null, patch.lastCheckedAt, id);
  }

  deleteRssFeed(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM rss_feeds WHERE id = ?").run(id).changes ?? 0) > 0;
  }

  listWebhooks(): WebhookSubscription[] {
    const rows = this.db.prepare("SELECT * FROM webhooks ORDER BY name ASC").all() as Record<string, unknown>[];
    return rows.map(r => ({
      id: String(r.id),
      name: String(r.name),
      targetUrl: String(r.target_url),
      secret: String(r.secret),
      events: safeJsonParse(String(r.events_json), []),
      enabled: Boolean(r.enabled),
      lastStatus: typeof r.last_status === "number" ? r.last_status : undefined,
      lastDeliveredAt: r.last_delivered_at ? String(r.last_delivered_at) : undefined,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    }));
  }

  upsertWebhook(input: { id?: string; name: string; targetUrl: string; secret?: string; events: string[]; enabled?: boolean }): WebhookSubscription {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    const secret = input.secret?.trim() || `whsec_${randomBytes(16).toString("hex")}`;
    this.db.prepare(`
      INSERT INTO webhooks (id, name, target_url, secret, events_json, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        target_url = excluded.target_url,
        events_json = excluded.events_json,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `).run(id, input.name, input.targetUrl, secret, JSON.stringify(input.events), input.enabled ?? true ? 1 : 0, now, now);
    return this.listWebhooks().find(w => w.id === id)!;
  }

  recordWebhookDelivery(delivery: Omit<WebhookDelivery, "id">): void {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO webhook_deliveries (id, webhook_id, event, payload_json, response_status, response_body, delivered_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      delivery.webhookId,
      delivery.event,
      delivery.payloadJson,
      delivery.responseStatus ?? null,
      delivery.responseBody ?? null,
      delivery.deliveredAt,
    );
    this.db.prepare("UPDATE webhooks SET last_status = ?, last_delivered_at = ? WHERE id = ?").run(
      delivery.responseStatus ?? null,
      delivery.deliveredAt,
      delivery.webhookId,
    );
  }

  deleteWebhook(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM webhooks WHERE id = ?").run(id).changes ?? 0) > 0;
  }

  enqueueFollowUpComment(input: {
    jobId: string;
    channelId: string;
    platform: string;
    commentText: string;
    dueAt: string;
  }): FollowUpComment {
    const record: FollowUpComment = {
      id: randomUUID(),
      ...input,
      status: "queued",
      createdAt: new Date().toISOString(),
    };
    this.db.prepare(`
      INSERT INTO follow_up_comments (id, job_id, channel_id, platform, comment_text, due_at, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(record.id, record.jobId, record.channelId, record.platform, record.commentText, record.dueAt, record.status, record.createdAt);
    return record;
  }

  listFollowUpComments(): FollowUpComment[] {
    const rows = this.db.prepare("SELECT * FROM follow_up_comments ORDER BY due_at ASC").all() as Record<string, unknown>[];
    return rows.map(r => ({
      id: String(r.id),
      jobId: String(r.job_id),
      channelId: String(r.channel_id),
      platform: String(r.platform),
      commentText: String(r.comment_text),
      dueAt: String(r.due_at),
      status: String(r.status) as FollowUpComment["status"],
      postedAt: r.posted_at ? String(r.posted_at) : undefined,
      lastError: r.last_error ? String(r.last_error) : undefined,
      createdAt: String(r.created_at),
    }));
  }

  // ---------------- API Keys ----------------

  createApiKey(name: string): { record: ApiKeyRecord; rawKey: string } {
    const rawKey = `vsp_live_${randomBytes(20).toString("hex")}`;
    const record: ApiKeyRecord = {
      id: randomUUID(),
      name: name.trim() || "Automation Key",
      keyPrefix: rawKey.slice(0, 14),
      keyHash: hashSecret(rawKey),
      createdAt: new Date().toISOString(),
    };
    this.db.prepare(`
      INSERT INTO api_keys (id, name, key_prefix, key_hash, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(record.id, record.name, record.keyPrefix, record.keyHash, record.createdAt);
    return { record, rawKey };
  }

  listApiKeys(): ApiKeyRecord[] {
    const rows = this.db.prepare("SELECT * FROM api_keys ORDER BY created_at DESC").all() as Record<string, unknown>[];
    return rows.map(r => ({
      id: String(r.id),
      name: String(r.name),
      keyPrefix: String(r.key_prefix),
      keyHash: String(r.key_hash),
      createdAt: String(r.created_at),
      lastUsedAt: r.last_used_at ? String(r.last_used_at) : undefined,
    }));
  }

  verifyApiKey(bearerToken: string): boolean {
    const hashed = hashSecret(bearerToken);
    const row = this.db.prepare("SELECT id FROM api_keys WHERE key_hash = ?").get(hashed) as { id: string } | undefined;
    if (!row) return false;
    this.db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(new Date().toISOString(), row.id);
    return true;
  }

  deleteApiKey(id: string): boolean {
    return Number(this.db.prepare("DELETE FROM api_keys WHERE id = ?").run(id).changes ?? 0) > 0;
  }

  // ---------------- Analytics ----------------

  recordChannelSnapshot(input: Omit<ChannelAnalyticsSnapshot, "id">): ChannelAnalyticsSnapshot {
    const snap: ChannelAnalyticsSnapshot = { id: randomUUID(), ...input };
    this.db.prepare(`
      INSERT INTO analytics_channel_snapshots (
        id, channel_id, platform, captured_at, followers, total_views, total_likes, total_videos, note, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      snap.id,
      snap.channelId,
      snap.platform,
      snap.capturedAt,
      snap.followers ?? null,
      snap.totalViews ?? null,
      snap.totalLikes ?? null,
      snap.totalVideos ?? null,
      snap.note ?? null,
      JSON.stringify(snap.rawJson ?? {}),
    );
    return snap;
  }

  listLatestChannelSnapshots(channelId?: string): ChannelAnalyticsSnapshot[] {
    const rows = (channelId
      ? this.db
          .prepare(`
            SELECT s.* FROM analytics_channel_snapshots s
            INNER JOIN (
              SELECT channel_id, platform, MAX(captured_at) AS max_ts
              FROM analytics_channel_snapshots WHERE channel_id = ? GROUP BY channel_id, platform
            ) latest ON s.channel_id = latest.channel_id AND s.platform = latest.platform AND s.captured_at = latest.max_ts
          `)
          .all(channelId)
      : this.db
          .prepare(`
            SELECT s.* FROM analytics_channel_snapshots s
            INNER JOIN (
              SELECT channel_id, platform, MAX(captured_at) AS max_ts
              FROM analytics_channel_snapshots GROUP BY channel_id, platform
            ) latest ON s.channel_id = latest.channel_id AND s.platform = latest.platform AND s.captured_at = latest.max_ts
          `)
          .all()) as Record<string, unknown>[];

    return rows.map(r => ({
      id: String(r.id),
      channelId: String(r.channel_id),
      platform: String(r.platform),
      capturedAt: String(r.captured_at),
      followers: typeof r.followers === "number" ? r.followers : undefined,
      totalViews: typeof r.total_views === "number" ? r.total_views : undefined,
      totalLikes: typeof r.total_likes === "number" ? r.total_likes : undefined,
      totalVideos: typeof r.total_videos === "number" ? r.total_videos : undefined,
      note: r.note ? String(r.note) : undefined,
      rawJson: safeJsonParse(String(r.raw_json ?? "{}"), {}),
    }));
  }

  listChannelSnapshotHistory(channelId?: string): ChannelAnalyticsSnapshot[] {
    const rows = (channelId
      ? this.db.prepare("SELECT * FROM analytics_channel_snapshots WHERE channel_id = ? ORDER BY captured_at ASC LIMIT 200").all(channelId)
      : this.db.prepare("SELECT * FROM analytics_channel_snapshots ORDER BY captured_at ASC LIMIT 200").all()) as Record<string, unknown>[];
    return rows.map(r => ({
      id: String(r.id),
      channelId: String(r.channel_id),
      platform: String(r.platform),
      capturedAt: String(r.captured_at),
      followers: typeof r.followers === "number" ? r.followers : undefined,
      totalViews: typeof r.total_views === "number" ? r.total_views : undefined,
      totalLikes: typeof r.total_likes === "number" ? r.total_likes : undefined,
      totalVideos: typeof r.total_videos === "number" ? r.total_videos : undefined,
      note: r.note ? String(r.note) : undefined,
      rawJson: safeJsonParse(String(r.raw_json ?? "{}"), {}),
    }));
  }

  upsertVideoMetric(input: Omit<VideoAnalyticsMetric, "id" | "engagementRate">): VideoAnalyticsMetric {
    const interactions = (input.likes ?? 0) + (input.comments ?? 0) + (input.shares ?? 0) + (input.saves ?? 0);
    const engagementRate = input.views > 0 ? Number(((interactions / input.views) * 100).toFixed(2)) : 0;
    const existing = this.db
      .prepare("SELECT id FROM analytics_video_metrics WHERE channel_id = ? AND platform = ? AND remote_id = ?")
      .get(input.channelId, input.platform, input.remoteId) as { id: string } | undefined;
    const id = existing?.id ?? randomUUID();

    this.db.prepare(`
      INSERT INTO analytics_video_metrics (
        id, channel_id, platform, remote_id, title, url, published_at,
        views, likes, comments, shares, saves, avg_watch_seconds, retention_pct, engagement_rate, captured_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(channel_id, platform, remote_id) DO UPDATE SET
        title = excluded.title,
        url = excluded.url,
        published_at = excluded.published_at,
        views = excluded.views,
        likes = excluded.likes,
        comments = excluded.comments,
        shares = excluded.shares,
        saves = excluded.saves,
        avg_watch_seconds = excluded.avg_watch_seconds,
        retention_pct = excluded.retention_pct,
        engagement_rate = excluded.engagement_rate,
        captured_at = excluded.captured_at
    `).run(
      id,
      input.channelId,
      input.platform,
      input.remoteId,
      input.title,
      input.url ?? null,
      input.publishedAt ?? null,
      input.views,
      input.likes,
      input.comments,
      input.shares,
      input.saves,
      input.avgWatchSeconds ?? null,
      input.retentionPct ?? null,
      engagementRate,
      input.capturedAt,
    );
    return { ...input, id, engagementRate };
  }

  listVideoMetrics(filters?: { channelId?: string; platform?: string }): VideoAnalyticsMetric[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filters?.channelId) {
      clauses.push("channel_id = ?");
      params.push(filters.channelId);
    }
    if (filters?.platform) {
      clauses.push("platform = ?");
      params.push(filters.platform);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db
      .prepare(`SELECT * FROM analytics_video_metrics ${where} ORDER BY views DESC, captured_at DESC`)
      .all(...params) as Record<string, unknown>[];
    return rows.map(r => ({
      id: String(r.id),
      channelId: String(r.channel_id),
      platform: String(r.platform),
      remoteId: String(r.remote_id),
      title: String(r.title),
      url: r.url ? String(r.url) : undefined,
      publishedAt: r.published_at ? String(r.published_at) : undefined,
      views: Number(r.views ?? 0),
      likes: Number(r.likes ?? 0),
      comments: Number(r.comments ?? 0),
      shares: Number(r.shares ?? 0),
      saves: Number(r.saves ?? 0),
      avgWatchSeconds: typeof r.avg_watch_seconds === "number" ? r.avg_watch_seconds : undefined,
      retentionPct: typeof r.retention_pct === "number" ? r.retention_pct : undefined,
      engagementRate: Number(r.engagement_rate ?? 0),
      capturedAt: String(r.captured_at),
    }));
  }

  saveOAuthToken(input: {
    channelId: string;
    platform: string;
    accountLabel?: string;
    accessToken: string;
    refreshToken?: string;
    scope?: string;
    expiresAt?: string;
  }): void {
    const now = new Date().toISOString();
    const existing = this.getOAuthToken(input.channelId, input.platform);
    const id = existing?.id ?? randomUUID();
    const refreshToken = input.refreshToken ?? existing?.refreshToken ?? null;
    this.db
      .prepare(`
        INSERT INTO oauth_tokens (
          id, channel_id, platform, account_label, access_token, refresh_token, scope, expires_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(channel_id, platform) DO UPDATE SET
          account_label = COALESCE(excluded.account_label, oauth_tokens.account_label),
          access_token = excluded.access_token,
          refresh_token = COALESCE(excluded.refresh_token, oauth_tokens.refresh_token),
          scope = COALESCE(excluded.scope, oauth_tokens.scope),
          expires_at = excluded.expires_at,
          updated_at = excluded.updated_at
      `)
      .run(
        id,
        input.channelId,
        input.platform,
        input.accountLabel ?? existing?.accountLabel ?? null,
        input.accessToken,
        refreshToken,
        input.scope ?? existing?.scope ?? null,
        input.expiresAt ?? null,
        now,
      );
  }

  getOAuthToken(channelId: string, platform: string): {
    id: string;
    channelId: string;
    platform: string;
    accountLabel?: string;
    accessToken: string;
    refreshToken?: string;
    scope?: string;
    expiresAt?: string;
    updatedAt: string;
  } | undefined {
    const row = this.db
      .prepare("SELECT * FROM oauth_tokens WHERE channel_id = ? AND platform = ?")
      .get(channelId, platform) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      id: String(row.id),
      channelId: String(row.channel_id),
      platform: String(row.platform),
      accountLabel: row.account_label ? String(row.account_label) : undefined,
      accessToken: String(row.access_token),
      refreshToken: row.refresh_token ? String(row.refresh_token) : undefined,
      scope: row.scope ? String(row.scope) : undefined,
      expiresAt: row.expires_at ? String(row.expires_at) : undefined,
      updatedAt: String(row.updated_at),
    };
  }

  deleteOAuthToken(channelId: string, platform: string): boolean {
    const info = this.db
      .prepare("DELETE FROM oauth_tokens WHERE channel_id = ? AND platform = ?")
      .run(channelId, platform);
    return Number(info.changes ?? 0) > 0;
  }

  listOAuthConnections(channelId?: string): Array<{
    channelId: string;
    platform: string;
    accountLabel?: string;
    expiresAt?: string;
    updatedAt: string;
  }> {
    const rows = (channelId
      ? this.db
          .prepare("SELECT channel_id, platform, account_label, expires_at, updated_at FROM oauth_tokens WHERE channel_id = ?")
          .all(channelId)
      : this.db
          .prepare("SELECT channel_id, platform, account_label, expires_at, updated_at FROM oauth_tokens")
          .all()) as Record<string, unknown>[];
    return rows.map(r => ({
      channelId: String(r.channel_id),
      platform: String(r.platform),
      accountLabel: r.account_label ? String(r.account_label) : undefined,
      expiresAt: r.expires_at ? String(r.expires_at) : undefined,
      updatedAt: String(r.updated_at),
    }));
  }

  getSetting(key: string): string | undefined {
    const row = this.db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value?: string } | undefined;
    return row?.value !== undefined ? String(row.value) : undefined;
  }

  setSetting(key: string, value: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `)
      .run(key, value, now);
  }

  statusSummary(): {
    channels: number;
    connections: number;
    signedInConnections: number;
    jobsByStatus: Record<string, number>;
    totalJobs: number;
  } {
    const channels = this.listChannels();
    const jobs = this.listJobs();
    const counts: Record<string, number> = {
      draft: 0,
      queued: 0,
      running: 0,
      scheduled: 0,
      published: 0,
      needs_login: 0,
      needs_human_action: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const j of jobs) {
      counts[j.status] = (counts[j.status] ?? 0) + 1;
    }
    const enabledConns = channels.flatMap(c => c.connections.filter(x => x.enabled));
    return {
      channels: channels.length,
      connections: enabledConns.length,
      signedInConnections: enabledConns.filter(c => c.sessionStatus === "signed_in").length,
      jobsByStatus: counts,
      totalJobs: jobs.length,
    };
  }
}
