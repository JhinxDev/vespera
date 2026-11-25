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

export type SessionState = "signed_in" | "logged_out" | "challenge" | "unconnected" | "unknown";

export type AdapterKind =
  | "edge_studio"
  | "youtube_api"
  | "x_api"
  | "instagram_graph_api"
  | "webhook"
  | "custom_web";

export interface PlatformDefinition {
  id: string;
  name: string;
  shortCode: string;
  category: "priority" | "social" | "community" | "publishing" | "custom";
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
}

export interface GroupConfig {
  id: string;
  name: string;
  color: string;
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
}

export interface ChannelConfig {
  id: string;
  name: string;
  groupId?: string;
  timezone: string;
  defaultPostTime: string;
  profileDir: string;
  connections: ChannelConnection[];
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
  status: JobStatus;
  remoteId?: string;
  remoteUrl?: string;
  lastError?: string;
  evidencePaths: string[];
  attemptsCount: number;
  payload: {
    title?: string;
    description?: string;
    caption?: string;
    postText?: string;
    hashtags?: string[];
    tags?: string[];
    category?: string;
    videoLanguage?: string;
    subreddit?: string;
    thumbnailPath?: string;
    captionsPath?: string;
    aiDisclosure?: boolean;
    madeForKids?: boolean;
    signatureId?: string;
    repeatIntervalDays?: number;
    repeatMax?: number;
    delayCommentMinutes?: number;
    followUpComment?: string;
  };
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
  outcome: string;
  remoteId?: string;
  remoteUrl?: string;
  screenshotFile?: string;
  message: string;
}

export interface PostingSet {
  id: string;
  name: string;
  timezone: string;
  slots: Array<{ dayOfWeek: number; time: string }>;
  platforms: string[];
  active: boolean;
}

export interface SignatureRecord {
  id: string;
  name: string;
  channelId?: string;
  platform?: string;
  body: string;
  autoAppend: boolean;
}

export interface AutomationPlug {
  id: string;
  name: string;
  scope: "internal" | "global";
  channelId?: string;
  triggerType: string;
  actionType: string;
  config: Record<string, unknown>;
  enabled: boolean;
  runsCount: number;
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
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  keyPrefix: string;
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
  engagementRate: number;
  capturedAt: string;
  coverAvailable?: boolean;
  matchedJobId?: string;
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
  topVideos: VideoAnalyticsMetric[];
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

export interface SchedulerStatus {
  enabled: boolean;
  running: boolean;
  intervalSeconds: number;
  lastTickAt?: string;
  lastRunCount: number;
  lastError?: string;
}

export interface LiveBrowserSession {
  active: boolean;
  channelId: string;
  platform?: string;
  url: string;
  startedAt: string;
  expiresAt: string;
  viewerPath: string;
}

export interface BootstrapPayload {
  ok: boolean;
  name: string;
  version: string;
  mode?: string;
  liveBrowser?: {
    available: boolean;
    session: LiveBrowserSession | null;
  };
  scheduler?: SchedulerStatus;
  summary: {
    channels: number;
    connections: number;
    signedInConnections: number;
    jobsByStatus: Record<string, number>;
    totalJobs: number;
  };
  platforms: PlatformDefinition[];
  groups: GroupConfig[];
  channels: ChannelConfig[];
  jobs: PublishJob[];
  postingSets: PostingSet[];
  signatures: SignatureRecord[];
  plugs: AutomationPlug[];
  rssFeeds: RssFeedRecord[];
  webhooks: WebhookSubscription[];
  apiKeys: ApiKeyRecord[];
  analytics: {
    snapshots: ChannelAnalyticsSnapshot[];
    intelligence: VideoIntelligenceReport;
  };
}
