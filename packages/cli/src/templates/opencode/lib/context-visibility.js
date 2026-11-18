/**
 * OpenCode v2 message-shaping helpers for the `context` session hook.
 *
 * v2 hook messages (`SessionRequestMessage = Message & { metadata? }` from
 * `@opencode/plugin/promise/session`) are flat objects:
 *
 *   { id?, role: "user" | "assistant" | "system" | "tool", content: Part[], metadata? }
 *
 * and text parts are `{ type: "text", text, cache?, providerMetadata? }`.
 * Unlike the v1 `experimental.chat.messages.transform` payload, part objects
 * carry no persisted identity (no `prt_` ids, no `sessionID` / `messageID`
 * fields), so the v1 persisted-part machinery (synthetic part id derivation)
 * has no v2 counterpart and was removed.
 *
 * [v2-verify] Shapes confirmed against @opencode/plugin@2.3.2
 * (dist/promise/session.d.ts) and @opencode/ai@2.3.2
 * (dist/schema/messages.d.ts). `metadata` is documented as the stored Session
 * message's metadata — read-only for the model call and NOT sent to the
 * model — so ephemeral-injection bookkeeping lives there.
 */

const TRELLIS_METADATA_KEY = "trellis"
const EPHEMERAL_PARTS_KEY = "ephemeralParts"

function trellisMetadata(message) {
  const metadata = message?.metadata
  if (!metadata || typeof metadata !== "object") return {}
  const trellis = metadata[TRELLIS_METADATA_KEY]
  return trellis && typeof trellis === "object" ? trellis : {}
}

/**
 * Number of leading text parts that were ephemerally injected by Trellis
 * plugins. Each `prependEphemeralText` call unshifts one part and bumps this
 * counter, so the synthetic parts are always the first N text parts.
 */
function ephemeralPartCount(message) {
  const count = trellisMetadata(message)[EPHEMERAL_PARTS_KEY]
  return Number.isInteger(count) && count > 0 ? count : 0
}

/**
 * Return the first ordinary user-authored text part of a v2 message.
 *
 * Trellis plugins can run in either order, so callers must not mistake a
 * synthetic context part injected by another plugin for the user's prompt.
 */
export function findUserTextPart(message) {
  const content = message?.content
  if (!Array.isArray(content)) return undefined
  let skip = ephemeralPartCount(message)
  for (const part of content) {
    if (part?.type !== "text" || typeof part.text !== "string") continue
    if (skip > 0) {
      skip -= 1
      continue
    }
    return part
  }
  return undefined
}

/**
 * Index of the last user message in a v2 `context` hook `messages` array.
 */
export function findLatestUserMessageIndex(messages) {
  if (!Array.isArray(messages)) return -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") return i
  }
  return -1
}

export function latestUserPromptText(messages) {
  const index = findLatestUserMessageIndex(messages)
  if (index < 0) return ""
  const part = findUserTextPart(messages[index])
  return typeof part?.text === "string" ? part.text : ""
}

export function transcriptHasAssistantMessage(messages) {
  if (!Array.isArray(messages)) return false
  return messages.some(message => message?.role === "assistant")
}

/**
 * Clone the latest user message and prepend an ephemeral synthetic text
 * part. The original message object and its `content` array are left
 * untouched; the v2 `context` hook only affects the outgoing model call,
 * and cloning additionally keeps each plugin's view of earlier parts stable
 * when multiple Trellis plugins run on the same event.
 */
export function prependEphemeralText(messages, text) {
  if (!Array.isArray(messages)) return false
  if (typeof text !== "string") return false
  const index = findLatestUserMessageIndex(messages)
  if (index < 0) return false
  const original = messages[index]
  const content = Array.isArray(original.content) ? original.content.slice() : []
  content.unshift({ type: "text", text })

  const priorMetadata =
    original.metadata && typeof original.metadata === "object" ? original.metadata : {}
  const priorTrellis = trellisMetadata(original)
  // [v2-verify] Replacing the array element with a plain-object copy relies
  // on the hook re-reading `event.messages` after mutation (the documented
  // mutation channel); SessionRequestMessage is a structural type, so a
  // spread copy carries every field the runtime sends on.
  messages[index] = {
    ...original,
    content,
    metadata: {
      ...priorMetadata,
      [TRELLIS_METADATA_KEY]: {
        ...priorTrellis,
        [EPHEMERAL_PARTS_KEY]: ephemeralPartCount(original) + 1,
      },
    },
  }
  return true
}
