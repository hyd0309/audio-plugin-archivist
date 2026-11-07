import { z } from 'zod';
import { AppError } from './security.mjs';
const tag=z.string().trim().min(1).max(80);
export const archiveSchema=z.object({
  '名称':z.string().trim().min(1).max(200).transform(s=>s.replace(/(?:\s*[(（]\s*(?:stereo|mono|立体声|单声道)\s*(?:手册|manual)?\s*[)）])+\s*$/ig,'').trim()),
  '类属':z.array(tag).min(1).max(20),'风格场景':z.array(tag).min(1).max(30),
  '官网链接':z.string().max(2000).default(''),'详细说明':z.string().min(20).max(40000),
  '界面图':z.string().nullable().default(null),
  '筛选标签':z.object({'厂商':z.string().max(200).default(''),'适用音源':z.array(tag).max(30).default([]),'音源依据':z.array(z.object({source:tag,page:z.number().int().positive(),quote:z.string().min(8).max(1000)})).default([])}).default({}),
  evidence:z.array(z.object({page:z.number().int().positive(),claim:z.string().max(1000)})).default([]),
  caveats:z.array(z.string().max(1000)).default([]),
}).strict();
const normalize=s=>s.normalize('NFKC').toLowerCase().replace(/\s/g,'');
export function validateRecord(value,pages) {
  const parsed=archiveSchema.safeParse(value);if(!parsed.success)throw new AppError('归档字段格式不正确，请检查名称、类属、风格场景和详细说明。');
  const r=parsed.data;if(!r.名称)throw new AppError('插件名称不能为空。');
  if(r.官网链接){let u;try{u=new URL(r.官网链接);}catch{throw new AppError('官网链接无效。');}if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw new AppError('官网链接无效。');if(!pages.some(p=>p.text?.includes(r.官网链接)||(p.links||[]).includes(r.官网链接)))throw new AppError('官网链接必须来自手册原文或超链接；无法核对时请留空。');}
  const heads=['核心功能概述','界面控件说明','操作实践指南'];let last=-1;
  for(const heading of heads){const at=r.详细说明.indexOf('## '+heading);if(at<=last)throw new AppError('详细说明须依次包含核心功能概述、界面控件说明、操作实践指南。');last=at;}
  if(/手册依据|Manual\s*[Pp]\.?\s*\d|(?:手册|Manual)第?\s*\d+\s*页/.test(r.详细说明))throw new AppError('详细说明不应附页码索引或手册依据章节。');
  if(r.界面图&&!pages.some(p=>'page-'+p.number===r.界面图))throw new AppError('界面图必须选自当前手册页面。');
  const tags=r.筛选标签;
  for(const source of tags.适用音源){if(!tags.音源依据.some(e=>e.source===source&&normalize(e.quote).length>=8&&pages.some(p=>p.number===e.page&&normalize(p.text).includes(normalize(e.quote)))))throw new AppError('适用音源缺少手册明确原句，请留空或核对原文。');}
  return r;
}
export function parseModel(text) {
  try{return JSON.parse(text.trim().replace(/^```(?:json)?\s*/,'').replace(/\s*```$/,''));}catch{throw new AppError('模型没有返回有效 JSON；请更换支持结构化输出的视觉模型。',502);}
}
export function markdownBlocks(markdown) {
  return markdown.split('\n').filter(l=>l.trim()).flatMap(line=>{
    const heading=line.match(/^(#{1,3})\s+(.+)/);const kind=heading?'heading'+heading[1].length:line.startsWith('- ')?'bullet':'text';
    const text=heading?heading[2]:kind==='bullet'?line.slice(2):line;
    return Array.from({length:Math.ceil(text.length/1400)},(_,i)=>block(text.slice(i*1400,(i+1)*1400),kind));
  });
}
export function block(text,kind='text') {return {block_type:{text:2,heading1:3,heading2:4,heading3:5,bullet:12}[kind],[kind]:{elements:[{text_run:{content:text}}]}};}
export const FIELDS=[['名称',1],['厂商',1],['界面图',17],['类属',4],['适用音源',4],['风格场景',4],['官网链接',15],['详情文档',15],['详细说明',1],['个人备注',1],['插件ID',1],['源PDF指纹',1],['最后同步时间',5],['归档进度',1]];
export function plain(value) {return Array.isArray(value)&&value.every(v=>v&&typeof v==='object'&&'text'in v)?value.map(v=>v.text).join(''):value;}
