.DEFAULT_GOAL := help
.PHONY: help dev dev-web

NODE ?= node
ARGS ?=

help:
	@echo "make dev                 rebuild and restart the local AGH backend and Web (port 4189)"
	@echo "make dev ARGS='--help'   show scope and port options"
	@echo "make dev-web             alias for make dev"

dev dev-web:
	$(NODE) tools/dev.mjs $(ARGS)
