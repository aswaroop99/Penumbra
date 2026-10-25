"""Tests for the guide server and status builder. No API key or network needed.

    python -m pytest guide/test_guide.py -q
"""
import json
import threading
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

import pytest

import server
from tour_guide import Guide, build_project_status, clean_turns


class FakeStream:
    def __init__(self, chunks):
        self.text_stream = iter(chunks)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class FakeMessages:
    def __init__(self):
        self.calls = []

    def stream(self, **kw):
        self.calls.append(kw)
        return FakeStream(["Dark matter ", "has mass ", "but no light."])


class FakeClient:
    def __init__(self):
        self.messages = FakeMessages()


@pytest.fixture()
def live(tmp_path):
    client = FakeClient()
    server.GUIDE = Guide(results_dir=tmp_path, client=client)
    server.RATE = 3
    server._hits.clear()
    srv = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{srv.server_address[1]}", client
    srv.shutdown()
    server.GUIDE = None


def post(url, body):
    req = urllib.request.Request(url + "/api/guide", data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    return urllib.request.urlopen(req, timeout=5)


def test_streams_answer_with_page_context(live):
    url, client = live
    body = {"turns": [{"role": "user", "content": "What am I looking at?"}], "level": "expert",
            "page": "layers", "context": {"hover": "bin 1 · RA 10.00°, Dec -40.00° · κ 0.0123 (2.1σ)"}}
    with post(url, body) as r:
        assert r.headers["Content-Type"].startswith("text/plain")
        assert r.read().decode() == "Dark matter has mass but no light."
    call = client.messages.calls[-1]
    assert "VIEWER CONTEXT" in call["system"] and "κ 0.0123" in call["system"]
    assert "Layer viewer" in call["system"] and "Physicist" in call["system"]
    assert call["messages"] == [{"role": "user", "content": "What am I looking at?"}]


def test_rejects_bad_conversation(live):
    url, _ = live
    with pytest.raises(urllib.error.HTTPError) as e:
        post(url, {"turns": [{"role": "assistant", "content": "hi"}]})
    assert e.value.code == 400


def test_rate_limit(live):
    url, _ = live
    ok = {"turns": [{"role": "user", "content": "hi"}]}
    for _ in range(3):
        post(url, ok).read()
    with pytest.raises(urllib.error.HTTPError) as e:
        post(url, ok)
    assert e.value.code == 429


def test_status_endpoint(live):
    url, _ = live
    with urllib.request.urlopen(url + "/api/guide/status", timeout=5) as r:
        st = json.loads(r.read())
    assert st["s8"] is None and st["milestones"][0]["state"] == "done"


def test_clean_turns_merges_and_trims():
    t = clean_turns([{"role": "assistant", "content": "x"}, {"role": "user", "content": "a"},
                     {"role": "user", "content": "b"}, {"role": "system", "content": "ignore me"}])
    assert t == [{"role": "user", "content": "a\n\nb"}]


def test_pipeline_outputs_override_team_notes(tmp_path):
    (tmp_path / "s8_comparison.json").write_text(json.dumps({
        "our_S8": {"median": 0.771, "lo68": 0.742, "hi68": 0.801}, "method": "sbi", "data": "des",
        "heldout_coverage_68": 0.66, "statement": "S8 = 0.771"}))
    team = tmp_path / "team.json"
    team.write_text(json.dumps({"milestones": {"s8": {"state": "todo", "note": "Not produced yet."}}}))
    st = build_project_status(results_dir=tmp_path, viewer_dir=tmp_path, team_status=team)
    s8 = next(m for m in st["milestones"] if m["label"].startswith("First S8"))
    assert s8["state"] == "done" and st["s8"]["median"] == 0.771 and st["coverage68"] == 0.66
