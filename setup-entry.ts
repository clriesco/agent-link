import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { agentLinkPlugin } from "./src/channel.js";

export default defineSetupPluginEntry(agentLinkPlugin);
