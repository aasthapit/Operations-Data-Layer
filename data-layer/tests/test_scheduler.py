"""
The periodic collector's scheduler.

There is very little here, and all of it matters at runtime: the job must be
registered at the configured interval, starting twice must not give a process
two schedulers racing each other over the same fleet, and shutting down must
leave the module able to start again (the API's lifespan does exactly that).

The real APScheduler is used, with an interval long enough that the job never
fires on its own - the job's body is invoked directly instead, so what is
asserted is the call the scheduler would make and not APScheduler's timing.
"""
import pytest

from app import scheduler
from app.settings import settings


@pytest.fixture(autouse=True)
def stopped():
    """No test may leave a live scheduler behind for the next one."""
    yield
    scheduler.stop_scheduler()


@pytest.fixture(autouse=True)
def slow_interval(monkeypatch):
    monkeypatch.setattr(settings, "refresh_interval_seconds", 3600)


def test_starting_registers_one_collect_job_at_the_configured_interval():
    sched = scheduler.start_scheduler()
    jobs = sched.get_jobs()
    assert [j.id for j in jobs] == ["collect"]
    assert jobs[0].trigger.interval.total_seconds() == 3600
    assert sched.running


def test_the_scheduled_job_asks_for_a_scheduled_collection(monkeypatch):
    asked = []
    monkeypatch.setattr(scheduler, "run_collection", lambda reason: asked.append(reason))
    job = scheduler.start_scheduler().get_jobs()[0]
    job.func()
    assert asked == ["scheduled"]


def test_a_sweep_that_overruns_is_coalesced_rather_than_stacked():
    """A fleet-wide sweep can outlast the interval; two of them at once would
    double every cluster's API load for no benefit."""
    job = scheduler.start_scheduler().get_jobs()[0]
    assert job.max_instances == 1 and job.coalesce is True


def test_starting_twice_gives_one_scheduler_not_two():
    first = scheduler.start_scheduler()
    assert scheduler.start_scheduler() is first
    assert len(first.get_jobs()) == 1


def test_stopping_shuts_the_scheduler_down_and_lets_it_start_again():
    first = scheduler.start_scheduler()
    scheduler.stop_scheduler()
    assert scheduler._scheduler is None
    assert not first.running

    second = scheduler.start_scheduler()
    assert second is not first and second.running


def test_stopping_a_scheduler_that_never_started_is_harmless():
    assert scheduler._scheduler is None
    scheduler.stop_scheduler()
    assert scheduler._scheduler is None
