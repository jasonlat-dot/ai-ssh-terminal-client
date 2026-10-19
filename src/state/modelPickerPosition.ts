type Rect = {left:number;right:number;top:number;bottom:number};

export function modelPickerPosition({trigger,panel,composer,viewport,groupRows,modelRows,level}:{
  trigger:Rect;panel?:Rect;composer?:Rect;viewport:{width:number;height:number};groupRows:number;modelRows:number;level:'group'|'model';
}) {
  const bounds=panel&&panel.right>panel.left?panel:undefined;
  const leftEdge=Math.max(8,(bounds?.left??0)+8);
  const rightEdge=Math.min(viewport.width-8,(bounds?.right??viewport.width)-8);
  const available=Math.max(1,rightEdge-leftEdge);
  const compact=available<500;
  const width=Math.min(compact?340:520,available);
  const anchor=composer&&composer.right>composer.left?composer:trigger;
  const center=(anchor.left+anchor.right)/2;
  const preferredLeft=!compact&&anchor===composer?anchor.left+12:center-width/2;
  const rows=compact?(level==='group'?groupRows:modelRows):Math.max(groupRows,modelRows);
  const desired=Math.min(340,48+rows*36);
  const above=trigger.top-14,below=viewport.height-trigger.bottom-14;
  const up=below<desired&&above>below;
  const height=Math.max(44,Math.min(desired,up?above:below));
  return {compact,width,height,left:Math.max(leftEdge,Math.min(preferredLeft,rightEdge-width)),
    top:Math.max(8,Math.min(up?trigger.top-6-height:trigger.bottom+6,viewport.height-height-8))};
}
