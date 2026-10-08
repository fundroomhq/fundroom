export {
  type AddressLookup,
  createOutboundHttp,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_MS,
  type OutboundHttp,
  type OutboundHttpOptions,
} from "./guard.js";
export {
  assessAddresses,
  assessUrl,
  BLOCKED_HOST_SUFFIXES,
  BLOCKED_HOSTS,
  DEFAULT_ALLOWED_PORTS,
  expandIpv6,
  isBlockedAddress,
  isBlockedHostname,
  normalizeHostname,
  type OutboundPolicy,
  type Verdict,
} from "./policy.js";
