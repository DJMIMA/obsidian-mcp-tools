<script lang="ts">
  import { FeatureSettings as McpServerInstallSettings } from "$/features/mcp-server-install";
  import { SemanticSearchSettingsView } from "$/features/semantic-search";
  import type McpServerPlugin from "$/main";

  export let plugin: McpServerPlugin;
</script>

<div class="settings-container">
  <McpServerInstallSettings {plugin} />
  <SemanticSearchSettingsView {plugin} />
</div>
