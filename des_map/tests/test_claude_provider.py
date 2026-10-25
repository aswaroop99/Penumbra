import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from map_reader.vision import describe


@pytest.fixture
def payload(tmp_path):
    image = tmp_path / 'image.png'
    image.write_bytes(b'test-image-bytes')
    evidence = {'layers': [{'id': 'image:bin0'}], 'objects': [{'id': 'peak:bin0:0'}],
                'summary': {'names': ['feature'], 'values': [1.0]}}
    answer = {'overview': 'A projected convergence map.', 'features': [],
              'limitations': ['Toy map; no cosmological inference.'], 'abstained': True}
    return image, evidence, answer


def test_claude_payload_and_provider_cache_isolation(payload, tmp_path):
    image, ev, answer = payload
    calls = []
    def create(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(id='msg_test', stop_reason='end_turn', content=[
            SimpleNamespace(type='text', text=json.dumps(answer))])
    claude = SimpleNamespace(messages=SimpleNamespace(create=create))
    a = describe(ev, [image], 'same-model-id', tmp_path/'cache', 'Describe', claude, provider='anthropic')
    b = describe(ev, [image], 'same-model-id', tmp_path/'cache', 'Describe', claude, provider='anthropic')
    assert a['provider'] == 'anthropic' and a['vlm_ran'] and not a['cached'] and b['cached']
    assert len(calls) == 1 and 'output_config' in calls[0]
    content = calls[0]['messages'][0]['content']
    assert any(block['type'] == 'image' and block['source']['type'] == 'base64' for block in content)
    assert 'input_image' not in json.dumps(content)
    openai = SimpleNamespace(responses=SimpleNamespace(create=lambda **kw: SimpleNamespace(
        id='resp_test', status='completed', output_text=json.dumps(answer))))
    c = describe(ev, [image], 'same-model-id', tmp_path/'cache', 'Describe', openai, provider='openai')
    assert c['cache_key'] != a['cache_key'] and c['provider'] == 'openai'


def test_claude_never_uses_openai_key(payload, tmp_path, monkeypatch):
    image, ev, _ = payload
    monkeypatch.delenv('ANTHROPIC_API_KEY', raising=False)
    monkeypatch.setenv('OPENAI_API_KEY', 'fake-openai-key-must-not-be-sent')
    with pytest.raises(ValueError, match='ANTHROPIC_API_KEY'):
        describe(ev, [image], 'claude-test', tmp_path/'cache', 'Describe', provider='anthropic')
    assert not (tmp_path/'cache').exists()


@pytest.mark.parametrize('stop_reason', ['max_tokens', 'refusal', 'tool_use'])
def test_claude_incomplete_or_refusal_not_cached(payload, tmp_path, stop_reason):
    image, ev, answer = payload
    client = SimpleNamespace(messages=SimpleNamespace(create=lambda **kw: SimpleNamespace(
        id='msg_test', stop_reason=stop_reason, content=[SimpleNamespace(type='text',text=json.dumps(answer))])))
    with pytest.raises(ValueError, match='incomplete or refused'):
        describe(ev, [image], 'claude-test', tmp_path/'cache', 'Describe', client, provider='anthropic')
    assert not (tmp_path/'cache').exists()


def test_claude_real_sdk_serialization_and_error_redaction(payload, tmp_path):
    import anthropic
    try:
        import httpx2 as httpx
    except ImportError:
        import httpx
    image, ev, answer = payload
    seen = []
    def handler(request):
        seen.append(request)
        if len(seen) > 1:
            return httpx.Response(401, json={'type':'error', 'error': {
                'type':'authentication_error', 'message':'sensitive-fake-key-do-not-echo'}})
        return httpx.Response(200, json={'id':'msg_mock', 'type':'message', 'role':'assistant',
            'model':'claude-test', 'content':[{'type':'text','text':json.dumps(answer)}],
            'stop_reason':'end_turn', 'stop_sequence':None, 'usage':{'input_tokens':100,'output_tokens':50}})
    with anthropic.Anthropic(api_key='test-not-real-anthropic-key', max_retries=0,
        http_client=anthropic.DefaultHttpxClient(transport=httpx.MockTransport(handler))) as client:
        result = describe(ev,[image],'claude-test',tmp_path/'cache','Describe',client,provider='anthropic')
        assert result['response_id'] == 'msg_mock'
        assert seen[0].headers['x-api-key'] == 'test-not-real-anthropic-key'
        assert 'authorization' not in seen[0].headers
        assert 'output_config' in json.loads(seen[0].content)
        with pytest.raises(ValueError) as exc:
            describe(ev,[image],'claude-test',tmp_path/'cache','Different question',client,provider='anthropic')
        assert 'HTTP 401' in str(exc.value) and 'sensitive-fake-key' not in str(exc.value)


def test_cli_provider_forwarded(tmp_path, monkeypatch):
    import map_reader.__main__ as cli
    cfg = tmp_path/'config.json'
    cfg.write_text('{}')
    calls = []
    monkeypatch.setattr(cli,'analyze',lambda *args,**kw:calls.append(kw))
    monkeypatch.setattr(sys,'argv',['map_reader','analyze','--map','unused.npz','--config',str(cfg),
        '--out',str(tmp_path/'out'),'--model','claude-test','--provider','anthropic'])
    cli.main()
    assert calls == [{'provider':'anthropic'}]
