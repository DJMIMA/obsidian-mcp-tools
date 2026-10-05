<script lang="ts">
  import type McpToolsPlugin from "$/main";
  import { Notice, SecretComponent } from "obsidian";
  import { onDestroy, onMount } from "svelte";
  import type { FeatureStatus } from "..";
  import {
    COHERE_DIMENSIONS,
    parseExcludeFolders,
    requiresRebuild,
    type SemanticSearchSettings,
  } from "../settings";
  import { confirmIndexing } from "./confirmIndexing";

  export let plugin: McpToolsPlugin;
  const feature = plugin.semanticSearch;

  let draft: SemanticSearchSettings = feature.getSettings();
  let excludeText = draft.excludeFolders.join("\n");
  let saved = JSON.stringify(feature.getSettings());
  let status: FeatureStatus = feature.status();
  let busy = false;
  let testResult = "";
  let estimateText = "";
  let cohereKeyEl: HTMLDivElement;
  let openaiKeyEl: HTMLDivElement;
  let cohereSecret: SecretComponent | undefined;
  let openaiSecret: SecretComponent | undefined;

  $: dirty = JSON.stringify({ ...draft, excludeFolders: parseExcludeFolders(excludeText) }) !== saved;

  const unsubscribe = feature.subscribe(() => {
    status = feature.status();
  });
  onDestroy(unsubscribe);

  onMount(() => {
    cohereSecret = new SecretComponent(plugin.app, cohereKeyEl)
      .setValue(draft.cohere.apiKeySecretId)
      .onChange((value) => {
        draft.cohere.apiKeySecretId = value;
      });
    openaiSecret = new SecretComponent(plugin.app, openaiKeyEl)
      .setValue(draft.openaiCompatible.apiKeySecretId)
      .onChange((value) => {
        draft.openaiCompatible.apiKeySecretId = value;
      });
  });

  const fmt = (n: number) => n.toLocaleString();
  const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

  function currentDraft(): SemanticSearchSettings {
    return { ...draft, excludeFolders: parseExcludeFolders(excludeText) };
  }

  function reset() {
    draft = feature.getSettings();
    excludeText = draft.excludeFolders.join("\n");
    saved = JSON.stringify(feature.getSettings());
    cohereSecret?.setValue(draft.cohere.apiKeySecretId);
    openaiSecret?.setValue(draft.openaiCompatible.apiKeySecretId);
  }

  async function save() {
    busy = true;
    try {
      const next = currentDraft();
      const rebuild = status.hasIndex && requiresRebuild(feature.getSettings(), next);
      if (rebuild) {
        const estimate = await feature.estimate(next);
        if (!(await confirmIndexing(plugin.app, "Rebuild the semantic index with the new settings?", estimate))) {
          reset();
          return;
        }
      }
      await feature.saveSettings(next, { rebuild });
      reset();
      new Notice("Semantic search settings saved");
    } catch (error) {
      new Notice(`Saving failed: ${errorMessage(error)}`);
    } finally {
      busy = false;
    }
  }

  async function testConnection() {
    busy = true;
    testResult = "Testing...";
    try {
      const result = await feature.testConnection(currentDraft());
      testResult = `OK: ${result.dimension} dimensions in ${result.ms} ms`;
    } catch (error) {
      testResult = `Failed: ${errorMessage(error)}`;
    } finally {
      busy = false;
    }
  }

  async function showEstimate() {
    busy = true;
    try {
      const e = await feature.estimate(currentDraft());
      estimateText = `${fmt(e.notes)} notes, ${fmt(e.chunks)} sections, ${fmt(e.chars)} characters would be sent`;
    } finally {
      busy = false;
    }
  }

  async function build() {
    if (status.state === "paused") {
      void feature.startBuild();
      return;
    }
    const estimate = await feature.estimate(feature.getSettings());
    const fresh = status.state === "ready";
    const title = fresh ? "Rebuild the semantic index from scratch?" : "Build the semantic index?";
    if (!(await confirmIndexing(plugin.app, title, estimate))) return;
    if (fresh) void feature.rebuild();
    else void feature.startBuild();
  }

  function stateLabel(s: FeatureStatus): string {
    switch (s.state) {
      case "unconfigured":
        return "Not configured: choose a provider, model and API key, then save";
      case "empty":
        return "Not built yet";
      case "building":
        return s.progress ? `Building: ${fmt(s.progress.done)} / ${fmt(s.progress.total)} notes` : "Building";
      case "paused":
        return `Paused: ${s.reason ?? ""}`;
      case "ready":
        return "Ready";
    }
  }
</script>

<div class="semantic-search">
  <h3>Semantic search</h3>

  <div class="row">
    <label for="ss-provider">Provider</label>
    <select id="ss-provider" bind:value={draft.provider}>
      <option value="cohere">Cohere</option>
      <option value="openai-compatible">OpenAI-compatible</option>
    </select>
  </div>

  <div class:hidden={draft.provider !== "cohere"}>
    <div class="row"><span>API key</span><div bind:this={cohereKeyEl}></div></div>
    <div class="row">
      <label for="ss-cohere-model">Model</label>
      <input id="ss-cohere-model" type="text" bind:value={draft.cohere.model} />
    </div>
    <div class="row">
      <label for="ss-cohere-dim">Dimension</label>
      <select id="ss-cohere-dim" bind:value={draft.cohere.dimension}>
        {#each COHERE_DIMENSIONS as dimension}<option value={dimension}>{dimension}</option>{/each}
      </select>
    </div>
  </div>

  <div class:hidden={draft.provider !== "openai-compatible"}>
    <div class="row">
      <label for="ss-oa-url">Base URL</label>
      <input id="ss-oa-url" type="text" placeholder="http://localhost:11434/v1" bind:value={draft.openaiCompatible.baseUrl} />
    </div>
    <div class="row"><span>API key (optional)</span><div bind:this={openaiKeyEl}></div></div>
    <div class="row">
      <label for="ss-oa-model">Model</label>
      <input id="ss-oa-model" type="text" bind:value={draft.openaiCompatible.model} />
    </div>
    <div class="row">
      <label for="ss-oa-dims">Dimensions (optional)</label>
      <input
        id="ss-oa-dims"
        type="number"
        min="1"
        value={draft.openaiCompatible.dimensions ?? ""}
        on:input={(event) => {
          const value = event.currentTarget.value;
          draft.openaiCompatible.dimensions = value ? Number(value) : null;
        }}
      />
    </div>
    <div class="row">
      <label for="ss-oa-qp">Query prefix</label>
      <input id="ss-oa-qp" type="text" placeholder="query: " bind:value={draft.openaiCompatible.queryPrefix} />
    </div>
    <div class="row">
      <label for="ss-oa-dp">Document prefix</label>
      <input id="ss-oa-dp" type="text" placeholder="passage: " bind:value={draft.openaiCompatible.documentPrefix} />
    </div>
    <div class="row">
      <label for="ss-oa-batch">Texts per request</label>
      <input id="ss-oa-batch" type="number" min="1" bind:value={draft.openaiCompatible.batchSize} />
    </div>
  </div>

  <div class="row column">
    <label for="ss-exclude">Excluded folders: one path prefix per line, never sent to the API (end with / to match only that folder)</label>
    <textarea id="ss-exclude" rows="4" bind:value={excludeText}></textarea>
  </div>
  <div class="row">
    <label for="ss-max">Max characters per section</label>
    <input id="ss-max" type="number" min="200" bind:value={draft.maxChunkChars} />
  </div>
  <div class="row">
    <label for="ss-result-max">Max characters per search result (0 = whole section)</label>
    <input id="ss-result-max" type="number" min="0" bind:value={draft.resultMaxChars} />
  </div>
  <div class="note">Cuts the text returned to the AI; the index is not rebuilt. A search call can override it with filter.maxTextChars.</div>

  <div class="buttons">
    <button on:click={save} disabled={busy || !dirty}>Save</button>
    <button on:click={testConnection} disabled={busy}>Test connection</button>
    <button on:click={showEstimate} disabled={busy}>Estimate</button>
  </div>
  {#if testResult}<div class="note">{testResult}</div>{/if}
  {#if estimateText}<div class="note">{estimateText}</div>{/if}

  <h4>Index</h4>
  <div class="status">
    <div>State: {stateLabel(status)}</div>
    {#if status.model}<div>Model: {status.model}</div>{/if}
    <div>Notes: {fmt(status.indexedNotes)} / {fmt(status.totalNotes)} · Sections: {fmt(status.chunks)}</div>
    <div>Tokens: {fmt(status.tokens.lastBuild)} in the last build · {fmt(status.tokens.total)} in total</div>
    {#if status.completedAt}<div>Last completed: {new Date(status.completedAt).toLocaleString()}</div>{/if}
    {#if status.failedNotes > 0}
      <details>
        <summary>{status.failedNotes} notes failed</summary>
        <ul>
          {#each status.failures as failure (failure.path)}
            <li><code>{failure.path}</code>: {failure.error}</li>
          {/each}
        </ul>
      </details>
    {/if}
  </div>
  <div class="buttons">
    {#if status.state === "building"}
      <button on:click={() => feature.cancelBuild()}>Cancel</button>
    {:else if status.state !== "unconfigured"}
      <button on:click={build} disabled={busy || dirty}>
        {status.state === "ready" ? "Rebuild" : status.state === "paused" ? "Resume" : "Build index"}
      </button>
    {/if}
    {#if dirty}<span class="note">Save the settings first.</span>{/if}
  </div>
</div>

<style>
  .row {
    display: flex;
    align-items: center;
    gap: 0.75em;
    margin-bottom: 0.5em;
  }
  .row.column {
    flex-direction: column;
    align-items: stretch;
  }
  .row > :first-child {
    min-width: 12em;
  }
  .hidden {
    display: none;
  }
  .buttons {
    display: flex;
    gap: 0.5em;
    align-items: center;
    margin: 0.75em 0;
  }
  .note {
    color: var(--text-muted);
  }
  .status > div {
    margin-bottom: 0.25em;
  }
</style>
