<script lang="ts">
  import { FeatureSettings as McpServerInstallSettings } from "src/features/mcp-server-install";
  import { SemanticSearchSettingsView } from "src/features/semantic-search";
  import type McpServerPlugin from "src/main";

  export let plugin: McpServerPlugin;
</script>

<div class="settings-container">
  <McpServerInstallSettings {plugin} />
  <SemanticSearchSettingsView {plugin} />
</div>
