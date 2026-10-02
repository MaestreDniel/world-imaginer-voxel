/**
 * Files the editors write and read (SP2b spec §3.4, §4.4): a download of a text file, and the text of a file
 * picked in a file input, read with FileReader (with onerror). DOM only; the formats are pure modules.
 */

/** How long a download's object URL lives: long enough for every browser to start the download. */
const REVOKE_AFTER_MS = 10000;

/** Downloads `text` as a file named `name`, through a temporary object URL on a link added to the page for the click. */
export function downloadText(name: string, text: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
}

/** The text of a picked file; rejects with the reader's error. */
export function readTextFile(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '');
    reader.onerror = () => reject(reader.error ?? new Error('the file could not be read'));
    reader.readAsText(file);
  });
}
