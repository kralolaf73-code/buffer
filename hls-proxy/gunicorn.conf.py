def post_worker_init(worker):
    # Start polling after Gunicorn forks the worker; this also works with --preload.
    from deneme import start_poller
    start_poller()
