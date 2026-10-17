import { Profiler, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { CleanupTool } from '../src/components/tools/CleanupTool';
import { AnalysisTool } from '../src/components/tools/AnalysisTool';
import { FinalReviewTool } from '../src/components/tools/FinalReviewTool';
import { SimilarityReviewTool } from '../src/components/tools/SimilarityReviewTool';
import { ExportTool } from '../src/components/tools/ExportTool';
import { CommandProvider } from '../src/components/workspace/Commands';
import { InspectorProvider } from '../src/components/workspace/InspectorHost';
import { useProjectStore } from '../src/stores/useProjectStore';
import { useUIStore } from '../src/stores/useUIStore';
import { createProject } from '../src/types';

export async function checkToolRendering(): Promise<string> {
  const frame=()=>new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
  const results:string[]=[];
  const tools: Array<[string,ComponentType<any>]> = [['Cleanup',CleanupTool],['Analysis',AnalysisTool],['Review',FinalReviewTool],['Similarity',SimilarityReviewTool],['Export',ExportTool]];
  for (const [name,Tool] of tools) {
    const project=createProject(`Render check ${name}`,'character');
    delete project.workspaceSettings.excludedProjectCategories;
    delete project.workspaceSettings.includedProjectCategories;
    useProjectStore.getState().loadProject(project);
    useUIStore.setState({projectDirectoryHandle:undefined});
    const host=document.createElement('div'); document.body.append(host);
    const root=createRoot(host);
    let renders=0;
    try {
      flushSync(()=>root.render(<CommandProvider><InspectorProvider><Profiler id={name} onRender={()=>{
        if (++renders>40) throw new Error(`${name}: continuous renders with empty category filters`);
      }}><Tool active={false} /></Profiler></InspectorProvider></CommandProvider>));
      for(let i=0;i<6;i++) await frame();
      const idle=renders;
      for(let i=0;i<3;i++) await frame();
      if(renders!==idle) throw new Error(`${name}: idle tool is still rendering`);
      flushSync(()=>useProjectStore.setState({workspaceSettings:{...project.workspaceSettings,excludedProjectCategories:['Project/src']}}));
      for(let i=0;i<6;i++) await frame();
      const changed=renders;
      for(let i=0;i<3;i++) await frame();
      if(changed===idle || renders!==changed) throw new Error(`${name}: category change did not settle`);
      results.push(`${name} ${renders} renders`);
    } finally { root.unmount(); host.remove(); }
  }
  return `PASS: absent category filters and category changes settle without render loops (${results.join(', ')}).`;
}
