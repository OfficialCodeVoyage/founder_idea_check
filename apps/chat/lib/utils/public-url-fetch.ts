import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";

/**
 * Server-side download of a URL a client supplied (a chat turn's file part).
 *
 * A client can name any URL, so a plain `fetch` lets it make this server read
 * from its own network: loopback services, the database, a cloud metadata
 * endpoint (169.254.169.254). This fetcher only reaches public addresses:
 *
 * - http(s) only, and no credentials in the URL;
 * - the host is resolved once per connection and EVERY returned address must
 *   be public (NON_PUBLIC_IPV4 / NON_PUBLIC_IPV6 below); the connection then uses those checked
 *   addresses (`guardedLookup` is the socket's own lookup), so a DNS answer
 *   cannot change between the check and the connect;
 *   an IP-literal host is checked directly, since sockets skip the lookup;
 * - redirects are not followed automatically: each hop is checked the same
 *   way, at most MAX_REDIRECTS of them;
 * - one deadline for the whole download, and a byte cap.
 *
 * A refusal throws RefusedUrlError, which the caller turns into a text part.
 */

// Two lists, never one: node:net's BlockList checks an IPv4 address against
// IPv6 rules too, through its IPv4-mapped form, so a single list holding
// `::ffff:0:0/96` refused every IPv4 address.
const NON_PUBLIC_IPV4 = new BlockList();
const NON_PUBLIC_IPV6 = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, cloud metadata
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.88.99.0", 24], // 6to4 relay
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved
  ["255.255.255.255", 32], // limited broadcast (inside 240/4; listed to be explicit)
] as const) {
  NON_PUBLIC_IPV4.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 96], // IPv4-compatible (deprecated), embeds an IPv4 address
  ["::", 128], // unspecified (inside ::/96; listed to be explicit)
  ["::1", 128], // loopback (inside ::/96; listed to be explicit)
  ["::ffff:0:0", 96], // IPv4-mapped: refused outright, whatever it maps to
  ["::ffff:0:0:0", 96], // IPv4-translated, embeds an IPv4 address
  ["64:ff9b::", 96], // NAT64, embeds an IPv4 address
  ["64:ff9b:1::", 48], // local NAT64
  ["100::", 64], // discard
  ["2001::", 23], // IETF protocol assignments: Teredo, ORCHID, benchmarking
  ["2001:db8::", 32], // documentation
  ["3fff::", 20], // documentation
  ["2002::", 16], // 6to4, embeds an IPv4 address
  ["5f00::", 16], // SRv6 segment identifiers, not hosts
  ["fc00::", 7], // unique local (includes fd00:ec2::254, AWS metadata)
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local (deprecated)
  ["ff00::", 8], // multicast
] as const) {
  NON_PUBLIC_IPV6.addSubnet(network, prefix, "ipv6");
}

const IPV6_BRACKETS = /^\[|\]$/g;
const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 15_000;
/** Twice the upload limit (`app/(chat)/api/files/upload/route.ts`). */
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export class RefusedUrlError extends Error {
  constructor(reason: string) {
    super(`Refused to download: ${reason}`);
    this.name = "RefusedUrlError";
  }
}

/** True for anything that is not a public unicast IP address. */
export function isNonPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return NON_PUBLIC_IPV4.check(address, "ipv4");
  }
  if (family === 6) {
    return NON_PUBLIC_IPV6.check(address, "ipv6");
  }
  return true;
}

/**
 * The socket's own lookup: resolves every address of the host and refuses the
 * connection unless all of them are public, then hands those same addresses to
 * the socket.
 */
const guardedLookup = ((hostname, options, callback) => {
  dnsLookup(
    hostname,
    { all: true, verbatim: true },
    (error, addresses: LookupAddress[]) => {
      if (error) {
        callback(error, "", 4);
        return;
      }
      if (
        addresses.length === 0 ||
        addresses.some(({ address }) => isNonPublicAddress(address))
      ) {
        callback(
          new RefusedUrlError(`${hostname} resolves to a non-public address`),
          "",
          4
        );
        return;
      }
      if ((options as { all?: boolean }).all) {
        (callback as (error: null, addresses: LookupAddress[]) => void)(
          null,
          addresses
        );
        return;
      }
      const [first] = addresses;
      callback(null, first.address, first.family);
    }
  );
}) as LookupFunction;

function assertFetchableUrl(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RefusedUrlError(`${url.protocol} URLs are not fetched`);
  }
  if (url.username || url.password) {
    throw new RefusedUrlError("URLs with credentials are not fetched");
  }
  const host = url.hostname.replace(IPV6_BRACKETS, "");
  if (isIP(host) && isNonPublicAddress(host)) {
    throw new RefusedUrlError(`${host} is not a public address`);
  }
}

function requestOnce(
  url: URL,
  signal: AbortSignal
): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const client = url.protocol === "https:" ? https : http;
    // agent: false — a fresh socket per request, so every hop runs
    // guardedLookup; no pooled socket is reused across hosts.
    const request = client.get(
      url,
      {
        agent: false,
        headers: { accept: "*/*" },
        lookup: guardedLookup,
        signal,
      },
      resolve
    );
    request.on("error", reject);
  });
}

async function readCapped(
  response: http.IncomingMessage,
  maxBytes: number
): Promise<Uint8Array> {
  const declared = Number(response.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxBytes) {
    response.destroy();
    throw new RefusedUrlError(`response is larger than ${maxBytes} bytes`);
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > maxBytes) {
      response.destroy();
      throw new RefusedUrlError(`response is larger than ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

export interface PublicUrlResponse {
  /** Empty unless the status is 2xx. */
  data: Uint8Array;
  mediaType: string | undefined;
  status: number;
}

export async function fetchPublicUrl(
  url: URL,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
  }: { timeoutMs?: number; maxBytes?: number } = {}
): Promise<PublicUrlResponse> {
  const signal = AbortSignal.timeout(timeoutMs);
  let current = url;
  for (let hop = 0; ; hop++) {
    assertFetchableUrl(current);
    const response = await requestOnce(current, signal);
    const status = response.statusCode ?? 0;
    const location = response.headers.location;
    if (status >= 300 && status < 400 && location) {
      response.resume();
      if (hop >= MAX_REDIRECTS) {
        throw new RefusedUrlError("too many redirects");
      }
      current = new URL(location, current);
      continue;
    }
    const mediaType = response.headers["content-type"] || undefined;
    if (status < 200 || status >= 300) {
      response.resume();
      return { data: new Uint8Array(), mediaType, status };
    }
    return { data: await readCapped(response, maxBytes), mediaType, status };
  }
}
