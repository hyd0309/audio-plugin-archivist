import argparse
import json
import webbrowser
from pathlib import Path
from . import store, workflow


def main():
    parser=argparse.ArgumentParser(description='音频效果器归档及选用助手')
    sub=parser.add_subparsers(dest='command')
    serve=sub.add_parser('serve')
    serve.add_argument('--port',type=int,default=8765)
    serve.add_argument('--open',action='store_true')
    ingest=sub.add_parser('archive')
    ingest.add_argument('pdf',type=Path)
    imp=sub.add_parser('import-record')
    imp.add_argument('id')
    imp.add_argument('json_file',type=Path)
    args=parser.parse_args()
    if args.command in {None,'serve'}:
        import uvicorn
        port=getattr(args,'port',8765)
        if getattr(args,'open',False):
            import threading
            threading.Timer(1.5,lambda:webbrowser.open(f'http://127.0.0.1:{port}')).start()
        uvicorn.run('audio_archive.api:app',host='127.0.0.1',port=port,access_log=False)
    else:
        from filelock import FileLock, Timeout
        store.DATA.mkdir(parents=True,exist_ok=True)
        try:
            with FileLock(str(store.DATA/'service.lock'),timeout=0):
                store.initialize()
                if args.command=='archive':
                    if args.pdf.stat().st_size>100*1024*1024:
                        parser.error('PDF 超过 100 MB')
                    item=workflow.ingest(args.pdf.read_bytes(),args.pdf.name)
                    workflow.process(item['id'])
                    print(json.dumps(store.get(item['id']),ensure_ascii=False,indent=2))
                elif args.command=='import-record':
                    print(json.dumps(workflow.import_record(args.id,json.loads(args.json_file.read_text('utf-8'))),ensure_ascii=False,indent=2))
        except Timeout:
            parser.error('本地工作台正在运行，请通过网页上传或导入，避免同时修改档案。')


if __name__=='__main__':
    main()
