"""One disposable process per document; parent kills its entire group at deadline."""
import base64
import json
import sys
from .classifier import RelevanceClassifier
from .config import Settings
from .documents import DocumentError, parse_document
from .pipeline import process
from .engines import selection, test_engine


def main():
    request = json.load(sys.stdin)
    settings = Settings(**request['settings'])
    if request.get('operation') == 'engine_info':
        from .engine_info import inspect_engine
        print(inspect_engine(settings, selection(request['engine'], settings)).model_dump_json())
        return
    if request.get('operation') == 'engine_test':
        print(json.dumps(test_engine(settings, selection(request['engine'], settings))))
        return
    if request.get('operation') == 'knowledge':
        from .knowledge import run_knowledge
        print(run_knowledge(request['query'], settings).model_dump_json())
        return
    try:
        document = parse_document(base64.b64decode(request['data'], validate=True),
                                  request['filename'], request['mime'], settings)
        if request.get('operation') == 'knowledge_decode':
            from .knowledge import DecodedKnowledge
            print(DecodedKnowledge(pages=[{'number': page.number, 'text': page.text, 'source': page.source} for page in document.pages], warnings=document.warnings).model_dump_json())
            return
        result = process(document, request['document_id'], request['mode'], settings, RelevanceClassifier(), request.get('engine'))
        print(result.model_dump_json())
    except DocumentError as exc:
        print(json.dumps({'inputError': str(exc)}))


if __name__ == '__main__':
    main()
