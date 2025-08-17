.DEFAULT_GOAL := help

DOCKER_COMPOSE ?= docker compose
SERVICES = registry rust-daemon node-daemon react-renderer html-renderer

# =====================
# High-level Targets
# =====================
.PHONY: help all build up down stack logs $(SERVICES) rebuild-% restart-% logs-% rules-logs form action clean ps lint lint-rust lint-node prune images

help:
	@echo "Available targets:"; \
	 echo "  make build            Build all images"; \
	 echo "  make up               Start registry only"; \
	 echo "  make all              Build then start registry"; \
	 echo "  make stack            Interactive launcher (registry + chosen daemon/renderer)"; \
	 echo "  make registry         Start registry"; \
	 echo "  make rust-daemon      Start Rust daemon"; \
	 echo "  make node-daemon      Start Node daemon"; \
	 echo "  make react-renderer   Start React renderer"; \
	 echo "  make html-renderer    Start HTML renderer"; \
	 echo "  make logs             Follow all logs"; \
	 echo "  make logs-<svc>       Follow one service (e.g. logs-registry)"; \
	 echo "  make rules-logs       Follow registry rules / action logs"; \
	 echo "  make form             Post sample FORM component"; \
	 echo "  make action FORM_ID=  Send SUBMIT action for given FORM component"; \
	 echo "  make rebuild-<svc>    Rebuild single service"; \
	 echo "  make restart-<svc>    Force recreate single service"; \
	 echo "  make ps               Show container status"; \
	 echo "  make clean            Stop and remove containers + volumes"; \
	 echo "  make prune            Prune dangling images"; \
	 echo "  make images           List project images"; \
	 echo "  make lint             Run all lint tasks (placeholders)";

all: build up

build:
	$(DOCKER_COMPOSE) build

# Start only registry by default for quicker interactive startup
up: registry

ps:
	$(DOCKER_COMPOSE) ps

# Interactive stack launcher
stack: registry
	@sleep 1; \
	echo "Select daemon:"; \
	echo "  1) Rust daemon"; \
	echo "  2) Node daemon"; \
	read -p "Enter choice [1-2]: " daemon_choice; \
	if [ "$$daemon_choice" = "1" ]; then \
		$(MAKE) rust-daemon; \
	elif [ "$$daemon_choice" = "2" ]; then \
		$(MAKE) node-daemon; \
	else \
		echo "Invalid daemon choice"; exit 1; \
	fi; \
	echo "Select renderer:"; \
	echo "  1) React renderer"; \
	echo "  2) HTML renderer"; \
	read -p "Enter choice [1-2]: " renderer_choice; \
	if [ "$$renderer_choice" = "1" ]; then \
		$(MAKE) react-renderer; \
	elif [ "$$renderer_choice" = "2" ]; then \
		$(MAKE) html-renderer; \
	else \
		echo "Invalid renderer choice"; exit 1; \
	fi; \
	echo "\nStack running. Use 'make logs' or 'make rules-logs'."

# Service start targets
$(SERVICES):
	$(DOCKER_COMPOSE) up -d $@

rebuild-%:
	$(DOCKER_COMPOSE) build $*

restart-%:
	$(DOCKER_COMPOSE) up -d --force-recreate --no-deps $*

logs:
	$(DOCKER_COMPOSE) logs -f

logs-%:
	$(DOCKER_COMPOSE) logs -f $*

rules-logs:
	$(DOCKER_COMPOSE) logs -f registry | egrep 'Registry: (Handling message|Processing action|Evaluating rules|Rule|Publishing new component|No rules triggered)'

form:
	@echo "Posting sample FORM component..."; \
	curl -s -X POST http://localhost:4000/render \
	  -H 'Content-Type: application/json' \
	  -d '{"type":"FORM","data":{"title":"Contact Form 📝","fields":[{"name":"name","label":"Your Name","type":"text"},{"name":"email","label":"Email Address","type":"email"},{"name":"message","label":"Message","type":"text"}],"submitText":"Send Message 🚀"}}' | jq '.'

action:
	@[ -n "$(FORM_ID)" ] || (echo "FORM_ID required: make action FORM_ID=<id>"; exit 1)
	@echo "Sending SUBMIT action for FORM $(FORM_ID)..."; \
	curl -s -X POST http://localhost:3001/graphql \
	  -H 'Content-Type: application/json' \
	  -d "{\"query\":\"mutation($$m:String!){sendMessage(message:$$m)}\",\"variables\":{\"m\":\"{\\\"direction\\\":\\\"ACTION\\\",\\\"payload\\\":{\\\"id\\\":\\\"action-$$(date +%s)\\\",\\\"componentId\\\":\\\"$(FORM_ID)\\\",\\\"actionType\\\":\\\"SUBMIT\\\",\\\"data\\\":{\\\"name\\\":\\\"Alice\\\",\\\"email\\\":\\\"alice@example.com\\\",\\\"message\\\":\\\"Hello Registry!\\\"},\\\"timestamp\\\":\\\"$$(date -u +%Y-%m-%dT%H:%M:%SZ)\\\"},\\\"metadata\\\":{\\\"acknowledged\\\":false,\\\"correlationId\\\":\\\"make-action\\\",\\\"error\\\":null}}\"}}" | jq '.'

# Lint placeholders (extend as needed)
lint: lint-rust lint-node

lint-rust:
	@echo "(rust lint placeholder) Run cargo fmt/clippy inside container or locally"

lint-node:
	@echo "(node lint placeholder) Run npm run lint inside respective service"

clean:
	$(DOCKER_COMPOSE) down -v

prune:
	docker image prune -f

images:
	docker images | grep daemon || true

down:
	$(DOCKER_COMPOSE) down