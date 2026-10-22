"""The cache probe must distinguish frontend builds from unrelated cache hits."""
import pytest

from scripts.verify_docker_cache import frontend_build_state


def test_cache_hit_requires_the_frontend_build_instruction():
    assert frontend_build_state("""#9 [frontend-build 4/6] RUN npm ci
#9 DONE 4.0s
#11 [frontend-build 6/6] RUN npm run build
#11 CACHED
""") == "cached"


def test_other_cached_steps_cannot_hide_an_executed_frontend_build():
    assert frontend_build_state("""#9 [frontend-build 4/6] RUN npm ci
#9 CACHED
#11 [frontend-build 6/6] RUN npm run build
#11 0.2 > tsc --noEmit && vite build
#11 DONE 19.4s
""") == "executed"


@pytest.mark.parametrize("log", [
    "#11 CACHED\n",
    "#11 [frontend-build 6/6] RUN npm run build\n#11 ERROR: failed\n",
    "#11 [frontend-build 6/6] RUN npm run build\n#11 ...\n#1 DONE\n",
    "#11 [frontend-build 6/6] RUN npm run build\n#11 CACHED\n#13 [other 2/2] RUN npm run build\n#13 DONE\n",
])
def test_missing_failed_or_ambiguous_steps_cannot_pass(log):
    with pytest.raises(ValueError):
        frontend_build_state(log)
