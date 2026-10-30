// Getting photos off the app, using only what iOS browsers allow.
// Nothing is uploaded: the share sheet and downloads hand the file straight to iOS.

export function canShareFiles(files) {
  try {
    return !!navigator.canShare && navigator.canShare({ files });
  } catch {
    return false;
  }
}

// Must be called directly from a tap, with no await before it: iOS only allows
// a share sheet during the tap's user activation. Files only, no text or title:
// adding text reportedly makes iOS drop the files.
export function shareFiles(files) {
  return navigator.share({ files });
}

export function isStandalone() {
  return matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

// Safari tabs put this in Files › Downloads. Reported to fail silently in
// Home Screen apps, so the UI only offers it in a browser tab.
export function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
