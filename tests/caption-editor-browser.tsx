import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CaptionEditor } from '../src/components/caption/CaptionEditor';
import '../src/index.css';

const suggestions = ['blue_eyes', 'blue_hair', 'brown_eyes', 'portrait', 'long_hair', 'short_hair', 'smile', 'looking_at_viewer', 'outdoors'];
function Harness() {
  const [value, setValue] = useState('subject_token, blue_eyes, portrait');
  return <main className="mx-auto max-w-2xl space-y-4 p-8">
    <h1 className="text-xl font-semibold">Caption editor checks</h1>
    <p className="text-sm text-muted-foreground">Autocomplete follows the cursor. Tab or Enter accepts a suggestion; Escape closes it.</p>
    <CaptionEditor value={value} onChange={setValue} suggestions={suggestions} requiredTag="subject_token" ariaLabel="Caption" rows={5} />
    <button className="rounded border p-2" onClick={() => setValue('subject_token, blue_eyes, blue eyes, portrait')}>Show duplicate example</button>
    <button className="ml-2 rounded border p-2" onClick={() => setValue('portrait, smile')}>Show missing trigger</button>
    <pre aria-label="Caption value" className="whitespace-pre-wrap rounded bg-secondary p-3 text-sm">{value}</pre>
  </main>;
}
const root = createRoot(document.getElementById('root')!); root.render(<Harness />);
import.meta.hot?.dispose(() => root.unmount());
