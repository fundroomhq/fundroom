/**
 * `@fundroom/integration-slack` — Slack app (OAuth v2 bot token): public channel list and
 * chat.postMessage (E3.6, ADR-0054). Stateless; the kernel owns tokens and passes them per call.
 */
export {
  BLOCKS_MAX,
  CHANNEL_MAX_PAGES,
  CHANNEL_PAGE_LIMIT,
  createSlackAdapter,
  escapeSlackText,
  mapSlackError,
  SLACK_API_BASE_URL,
  SLACK_AUTH_BASE_URL,
  SLACK_BOT_SCOPES,
  type SlackAdapterOptions,
  slackMeta,
  TEXT_MAX_LENGTH,
} from "./adapter.js";
