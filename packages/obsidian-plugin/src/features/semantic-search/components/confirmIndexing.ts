import { Modal, Setting, type App } from "obsidian";
import type { IndexEstimate } from "../indexer";

/** Asks before sending the vault to the embedding API. Resolves true only when "Start" is pressed. */
export function confirmIndexing(app: App, title: string, estimate: IndexEstimate): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const answer = (value: boolean, modal: Modal) => {
      answered = true;
      resolve(value);
      modal.close();
    };
    const modal = new (class extends Modal {
      onOpen() {
        this.titleEl.setText(title);
        this.contentEl.createEl("p", {
          text:
            `${estimate.notes.toLocaleString()} notes, ${estimate.chunks.toLocaleString()} sections and ` +
            `${estimate.chars.toLocaleString()} characters will be sent to the embedding API. ` +
            "Excluded folders are not sent.",
        });
        new Setting(this.contentEl)
          .addButton((button) => button.setButtonText("Cancel").onClick(() => answer(false, this)))
          .addButton((button) => button.setButtonText("Start").setCta().onClick(() => answer(true, this)));
      }
      onClose() {
        if (!answered) resolve(false);
        this.contentEl.empty();
      }
    })(app);
    modal.open();
  });
}
