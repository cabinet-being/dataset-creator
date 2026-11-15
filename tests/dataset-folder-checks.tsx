import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { createProject, createSourceImage } from '../src/types';
import { createProjectDirectory, readProjectDirectory, type ProjectDirectoryHandle } from '../src/services/project/projectDirectoryService';
import { useProjectSave, flushProjectSave } from '../src/hooks/useProjectSave';
import { setAssetsDatasetMembership } from '../src/lib/assetActions';
import { toWorkspaceImages } from '../src/lib/workspaceImages';
import { buildExportPlan, exportPlanAsZip } from '../src/services/export/exportPlan';
import { useProjectStore } from '../src/stores/useProjectStore';
import { useUIStore } from '../src/stores/useUIStore';
import { useHistoryStore } from '../src/stores/useHistoryStore';
import JSZip from 'jszip';

export async function checkDatasetFolder(): Promise<string> {
  const root = await (await navigator.storage.getDirectory()).getDirectoryHandle(`dataset-check-${crypto.randomUUID()}`,{create:true});
  const directory = root as unknown as ProjectDirectoryHandle;
  const canvas=document.createElement('canvas'); canvas.width=2; canvas.height=2;
  canvas.getContext('2d')!.fillRect(0,0,2,2);
  const image=await new Promise<Blob>(resolve=>canvas.toBlob(blob=>resolve(blob!),'image/png'));
  const source={...createSourceImage(image,'sample.png',2,2),originalFilePath:'inbox/sample.png',tags:['test caption']};
  const project={...createProject('Dataset checks','character'),sourceImages:{[source.id]:source}};
  await createProjectDirectory(directory,project);
  useProjectStore.getState().loadProject(project);
  useUIStore.getState().setProjectDirectory({handle:directory,name:project.name});
  const host=document.createElement('div'); document.body.append(host);
  const reactRoot=createRoot(host);
  function Saving() { useProjectSave(); return null; }
  const assert=(condition:boolean,message:string)=>{if(!condition)throw new Error(message);};
  const current=()=>toWorkspaceImages(Object.values(useProjectStore.getState().sourceImages),[]);
  const path=()=>useProjectStore.getState().sourceImages[source.id].originalFilePath;
  try {
    flushSync(()=>reactRoot.render(<Saving />));
    await setAssetsDatasetMembership(current(),true);
    assert(path()==='dataset/sample.png','Include physically moves the source into Dataset');
    const data=await root.getDirectoryHandle('dataset');
    assert((await (await data.getFileHandle('sample.png')).getFile()).size===image.size,'The image bytes survive the move');
    const plan=await buildExportPlan({scope:'dataset',items:[],dataset:project.dataset,directory,blacklist:[]});
    assert(plan.entries.length===1,'Export discovers physical files even with an empty UI selection');
    const zip=await JSZip.loadAsync(await (await exportPlanAsZip(plan)).arrayBuffer());
    assert((await zip.file('sample.txt')!.async('string')).includes('test caption'),'Export preserves the caption');
    await useHistoryStore.getState().undo(); assert(path()==='inbox/sample.png','Undo moves the file back');
    await useHistoryStore.getState().redo(); assert(path()==='dataset/sample.png','Redo moves the file into Dataset');
    await setAssetsDatasetMembership(current(),false); assert(path()==='inbox/sample.png','Exclude physically returns the file to shared');
    const empty=await buildExportPlan({scope:'dataset',items:current(),dataset:project.dataset,directory,blacklist:[]});
    assert(empty.entries.length===0,'Removed files cannot leak into Dataset export');
    await useHistoryStore.getState().undo(); await flushProjectSave();
    const reopened=await readProjectDirectory(directory);
    assert(reopened.sourceImages[source.id].originalFilePath==='dataset/sample.png','Save/reopen preserves physical membership and identity');
    assert(reopened.sourceImages[source.id].tags?.[0]==='test caption','Caption survives save/reopen');
    return 'PASS: physical include/remove, image bytes, captions, actual ZIP, undo/redo, source identity and save/reopen with the real save queue and IndexedDB.';
  } finally { reactRoot.unmount(); host.remove(); }
}
