const form = document.getElementById('compress-form');
const status = document.getElementById('status');
const downloads = document.getElementById('downloads');
const submit = document.getElementById('submit');

form.addEventListener('submit', async event => {
  event.preventDefault();
  const files = [...document.getElementById('files').files];
  if (files.some(file => file.size > 10 * 1024 * 1024)) {
    status.textContent = 'Choose files no larger than 10 MB each.';
    return;
  }
  submit.disabled = true;
  downloads.replaceChildren();
  try {
    for (const [index, file] of files.entries()) {
      status.textContent = `Compressing ${index + 1} of ${files.length}: ${file.name}`;
      const { uploadToken } = await BlobUpload.uploadToGCS(file);
      const response = await fetch('/api/gcp/compress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uploadToken }),
      });
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error(result.error || 'Compression failed');
      if (typeof result.url !== 'string') throw new Error('Missing download URL');
      const url = new URL(result.url, location.href);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid download URL');
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = url.href;
      link.textContent = `Download ${file.name}`;
      link.rel = 'noopener noreferrer';
      item.append(link);
      downloads.append(item);
    }
    status.textContent = 'Done. Download your results above.';
  } catch (error) {
    status.textContent = `${error.message}\nThis demo requires your own configured backend; see README.md.`;
  } finally {
    submit.disabled = false;
  }
});
