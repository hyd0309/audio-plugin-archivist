'use client';
import { useRef } from 'react';
import { APP_PATH } from '../lib/paths';
export default function LocalDownload(){
  const dialog=useRef<HTMLDialogElement>(null);
  const url=APP_PATH+'/downloads/audio-plugin-archivist-local.zip';
  return <section className="local-download"><div><p className="eyebrow">YOUR OWN WORKSPACE</p><h2>也可以，在自己的电脑上运行。</h2><p>下载本地版，自行配置模型与飞书。适用于 Windows；数据保存在本机。</p></div><a className="button" href={url} download onClick={()=>dialog.current?.showModal()}>下载并部署到本地 ↓</a><dialog ref={dialog} className="deploy-dialog" aria-labelledby="deploy-title" onClick={e=>{if(e.target===e.currentTarget)dialog.current?.close();}}><h2 id="deploy-title">本地部署 · 四步开始</h2><p>浏览器将下载 ZIP。如未开始，可<a href={url} download>重新下载</a>。</p><ol><li>安装 <a href="https://www.anaconda.com/docs/getting-started/miniconda/install" target="_blank" rel="noreferrer">Miniconda</a>，然后完整解压下载包。</li><li>打开 Miniconda Prompt，进入解压目录，运行 <code>install.cmd</code>。首次安装需要联网，会创建独立环境。</li><li>运行 <code>start.cmd</code>，浏览器将打开本地工作台。保留运行窗口；关闭窗口即停止服务。</li><li>在设置中填写自己的视觉模型 API 和飞书应用配置；飞书重定向 URL 填 <code>http://127.0.0.1:8765/api/feishu/callback</code>，保存后授权。</li></ol><p>完整说明见压缩包内 README.md。本地版无需网站登录，配置与档案保存在解压目录的 data 文件夹中，请妥善保管。</p><button autoFocus onClick={()=>dialog.current?.close()}>知道了</button></dialog></section>;
}
