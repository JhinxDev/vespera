export type AdapterKind =
  | "edge_studio"
  | "youtube_api"
  | "x_api"
  | "instagram_graph_api"
  | "webhook"
  | "custom_web";

export type SessionState =
  | "signed_in"
  | "logged_out"
  | "challenge"
  | "unconnected"
  | "unknown";

export type JobStatus =
  | "draft"
  | "queued"
  | "running"
  | "scheduled"
  | "published"
  | "failed"
  | "needs_login"
  | "needs_human_action"
  | "cancelled";

export type PlatformCategory =
  | "priority"
  | "social"
  | "community"
  | "publishing"
  | "custom";

export interface PlatformDefinition {
  id: string;
  name: string;
  shortCode: string;
  category: PlatformCategory;
  accentHex: string;
  loginUrl: string;
  composeUrl: string;
  analyticsUrl?: string;
  featuredOrder?: number;
  supportsVideo: boolean;
  supportsScheduling: boolean;
  supportsSubreddit: boolean;
  supportsCustomThumbnail: boolean;
  supportsFirstComment: boolean;
  authModes: AdapterKind[];
  builtIn: boolean;
  notes?: string;
  createdAt: string;
}

export interface GroupConfig {
  id: string;
  name: string;
  color: string;
  createdAt: string;
}

export interface ChannelConnection {
  id: string;
  channelId: string;
  platform: string;
  handle: string;
  enabled: boolean;
  adapter: AdapterKind;
  customLoginUrl?: string;
  customComposeUrl?: string;
  customAnalyticsUrl?: string;
  webhookUrl?: string;
  sessionStatus: SessionState;
  observedHandle?: string;
  lastCheckedAt?: string;
  evidenceFile?: string;
  sessionNote?: string;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ChannelConfig {
  id: string;
  name: string;
  groupId?: string;
  timezone: string;
  defaultPostTime: string;
  profileDir: string;
  connections: ChannelConnection[];
  createdAt: string;
  updatedAt: string;
}

export interface PublishJobPayload {
  title?: string;
  description?: string;
  caption?: string;
  postText?: string;
  hashtags?: string[];
  subreddit?: string;
  thumbnailPath?: string;
  madeForKids?: boolean;
  aiDisclosure?: boolean;
  signatureId?: string;
  postingSetId?: string;
  repeatIntervalDays?: number;
  repeatCount?: number;
  repeatMax?: number;
  delayCommentMinutes?: number;
  followUpComment?: string;
  method?: string;
}

export interface PublishJob {
  id: string;
  idempotencyKey: string;
  channelId: string;
  videoId: string;
  currentVersionId: string;
  episode: string;
  title: string;
  platform: string;
  handle: string;
  adapter: AdapterKind;
  targetDate: string;
  publishAt: string;
  publishNowIfPastSlot: boolean;
  videoPath: string;
  videoSha256: string;
  videoBytes: number;
  coverPath?: string;
  coverSha256?: string;
  status: JobStatus;
  remoteId?: string;
  remoteUrl?: string;
  lastError?: string;
  evidencePaths: string[];
  attemptsCount: number;
  payload: PublishJobPayload;
  createdAt: string;
  updatedAt: string;
  executedAt?: string;
}

export interface PublishAttempt {
  id: string;
  jobId: string;
  adapter: AdapterKind;
  startedAt: string;
  finishedAt: string;
  outcome: JobStatus | "dry_run_ok" | "reconciled_receipt";
  remoteId?: string;
  remoteUrl?: string;
  screenshotFile?: string;
  message: string;
}

export interface FollowUpComment {
  id: string;
  jobId: string;
  channelId: string;
  platform: string;
  commentText: string;
  dueAt: string;
  status: "queued" | "posted" | "failed" | "skipped";
  postedAt?: string;
  lastError?: string;
  createdAt: string;
}

export interface PostingSet {
  id: string;
  name: string;
  timezone: string;
  slots: Array<{ dayOfWeek: number; time: string }>;
  platforms: string[];
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SignatureRecord {
  id: string;
  name: string;
  channelId?: string;
  platform?: string;
  body: string;
  autoAppend: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AutomationPlug {
  id: string;
  name: string;
  scope: "internal" | "global";
  channelId?: string;
  triggerType: "on_publish" | "on_milestone_views" | "on_crosspost" | "on_rss_item";
  actionType: "follow_up_comment" | "append_signature" | "cross_post" | "webhook_notify";
  config: Record<string, unknown>;
  enabled: boolean;
  lastRunAt?: string;
  runsCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface RssFeedRecord {
  id: string;
  name: string;
  feedUrl: string;
  channelId: string;
  platforms: string[];
  autoPublish: boolean;
  defaultTime: string;
  lastCheckedAt?: string;
  lastGuid?: string;
  lastError?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookSubscription {
  id: string;
  name: string;
  targetUrl: string;
  secret: string;
  events: string[];
  enabled: boolean;
  lastStatus?: number;
  lastDeliveredAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookDelivery {
  id: string;
  webhookId: string;
  event: string;
  payloadJson: string;
  responseStatus?: number;
  responseBody?: string;
  deliveredAt: string;
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  createdAt: string;
  lastUsedAt?: string;
}

export interface ChannelAnalyticsSnapshot {
  id: string;
  channelId: string;
  platform: string;
  capturedAt: string;
  followers?: number;
  totalViews?: number;
  totalLikes?: number;
  totalVideos?: number;
  note?: string;
  rawJson: Record<string, unknown>;
}

export interface VideoAnalyticsMetric {
  id: string;
  channelId: string;
  platform: string;
  remoteId: string;
  title: string;
  url?: string;
  publishedAt?: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  avgWatchSeconds?: number;
  retentionPct?: number;
  engagementRate: number;
  capturedAt: string;
}

export interface VideoIntelligenceReport {
  generatedAt: string;
  hasLiveData: boolean;
  summary: {
    trackedVideos: number;
    totalViews: number;
    totalFollowers: number;
    avgEngagementRate: number;
    topPlatform?: string;
  };
  platformBreakdown: Array<{
    platform: string;
    followers: number;
    views: number;
    videos: number;
    avgEngagementRate: number;
    lastCapturedAt?: string;
  }>;
  topVideos: Array<VideoAnalyticsMetric & { coverAvailable: boolean; matchedJobId?: string }>;
  titleInsights: Array<{
    bucket: string;
    count: number;
    avgViews: number;
    avgEngagementRate: number;
  }>;
  crossPlatformGaps: Array<{
    videoId: string;
    title: string;
    channelId: string;
    presentOn: string[];
    missingOn: string[];
  }>;
  takeaways: string[];
  markdownBrief: string;
}

export interface SessionCheckResult {
  channelId: string;
  platform: string;
  status: SessionState;
  expectedHandle: string;
  observedHandle?: string;
  checkedAt: string;
  url?: string;
  screenshotFile?: string;
  note?: string;
}

export interface ExecutionResult {
  status: JobStatus;
  dryRun?: boolean;
  remoteId?: string;
  remoteUrl?: string;
  screenshotFile?: string;
  message: string;
}

export interface ChannelsFileDocument {
  groups?: Array<{ id: string; name: string; color?: string }>;
  customPlatforms?: Array<Partial<PlatformDefinition> & { id: string; name: string; loginUrl: string }>;
  channels: Array<{
    id: string;
    name: string;
    groupId?: string;
    timezone?: string;
    defaultPostTime?: string;
    profileDir?: string;
    connections: Array<{
      platform: string;
      handle: string;
      enabled?: boolean;
      adapter?: AdapterKind;
      customLoginUrl?: string;
      customComposeUrl?: string;
      customAnalyticsUrl?: string;
      webhookUrl?: string;
      metadata?: Record<string, unknown>;
    }>;
  }>;
}

export interface ManifestTarget {
  platform?: string;
  handle?: string;
  method?: string;
  title?: string;
  description?: string;
  caption?: string;
  postText?: string;
  hashtags?: string[];
  subreddit?: string;
  scheduleAt?: string;
  publishNowIfPastSlot?: boolean;
  madeForKids?: boolean;
  alteredContentDisclosure?: boolean;
  aiGeneratedDisclosure?: boolean;
  aiLabel?: boolean;
  coverPath?: string;
  thumbnailPath?: string;
}

export interface PublishingManifest {
  deliverables: Array<{
    channelId: string;
    videoId: string;
    currentVersionId: string;
    episode: string;
    title: string;
    targetDate: string;
    publishAtToronto: string;
    publishNowIfPastSlot?: boolean;
    files: {
      videoPath: string;
      videoSha256: string;
      videoBytes: number;
      coverPath?: string;
      coverSha256?: string;
    };
    platforms: Record<string, ManifestTarget | undefined>;
  }>;
}

export interface ExistingReceipt {
  channelId: string;
  videoId: string;
  platform: string;
  targetDate: string;
  status: JobStatus;
  remoteId?: string;
  remoteUrl?: string;
  publishedAtToronto?: string;
  scheduledAtToronto?: string;
  verifiedEvidence?: {
    screenshot?: string;
  };
}
