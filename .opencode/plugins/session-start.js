/* global process */
/**
 * Trellis Session Start Plugin
 *
 * Injects compact SessionStart context into the copy of the latest user
 * message that OpenCode sends to the model. Registered on the v2
 * `context` session hook, whose changes affect only the outgoing model
 * call — TUI / Web / SQLite history stay untouched (issue #553).
 *
 * OpenCode v2 plugin shape: default-export `{ id, async setup(ctx) }`.
 * Deliberately does NOT import `@opencode/plugin` — the shipped template
 * has no package.json / node_modules, so a bare import would fail to
 * resolve. `Plugin.define` is only a typing helper; the runtime accepts a
 * plain definition object.
 */

import { TrellisContext, debugLog, isTrellisSubagent } from "../lib/trellis-context.js"
import {
  prependEphemeralText,
  transcriptHasAssistantMessage,
} from "../lib/context-visibility.js"
import { buildSessionContext } from "../lib/session-utils.js"

const FIRST_REPLY_NOTICE_RE = /<first-reply-notice>[\s\S]*?<\/first-reply-notice>\s*/g

function stripFirstReplyNotice(context) {
  return context.replace(FIRST_REPLY_NOTICE_RE, "")
}

export default {
  id: "trellis.session-start",
  async setup(ctx) {
    const directory = ctx.location.directory
    const trellis = new TrellisContext(directory)
    debugLog("session", "Plugin loaded, directory:", directory)

    const registration = await ctx.session.hook("context", async (event) => {
      try {
        const agent = event.agent || "unknown"
        debugLog("session", "context hook called, agent:", agent)

        if (isTrellisSubagent(event)) {
          debugLog("session", "Skipping trellis subagent turn:", agent)
          return
        }

        if (process.env.TRELLIS_HOOKS === "0" || process.env.TRELLIS_DISABLE_HOOKS === "1") {
          debugLog("session", "Skipping - TRELLIS_HOOKS disabled")
          return
        }

        if (process.env.OPENCODE_NON_INTERACTIVE === "1") {
          debugLog("session", "Skipping - non-interactive mode")
          return
        }

        const platformInput = { sessionID: event.sessionID, agent: event.agent }
        let context = buildSessionContext(trellis, platformInput)
        if (transcriptHasAssistantMessage(event.messages)) {
          context = stripFirstReplyNotice(context)
        }
        debugLog("session", "Built context, length:", context.length)
        prependEphemeralText(event.messages, context)
      } catch (error) {
        debugLog("session", "Error in context hook:", error.message, error.stack)
      }
    })

    return () => registration.dispose()
  },
}
