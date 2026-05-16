.DEFAULT_GOAL := help

DOCKER_COMPOSE ?= docker compose
DAEMONS        = rust-daemon node-daemon
OTHER_SERVICES = registry react-renderer html-renderer mongo graph
SERVICES       = $(DAEMONS) $(OTHER_SERVICES)

# =====================
# High-level Targets
# =====================
.PHONY: help all build up down stack logs $(SERVICES) rebuild-% restart-% logs-% rules-logs form action test clean ps prune images contracts-install contracts-build contracts-typecheck contracts-clean

help:
	@echo "Available targets:"; \
	 echo "  make build            Build all images"; \
	 echo "  make up               Start registry only"; \
	 echo "  make all              Build then start registry"; \
	 echo "  make stack            Interactive launcher (registry + chosen daemon/renderer)"; \
	 echo "  make registry         Start registry"; \
	 echo "  make rust-daemon      Start Rust daemon (also starts graph + mongo)"; \
	 echo "  make node-daemon      Start Node daemon (also starts graph + mongo)"; \
	 echo "  make graph            Start graph service + mongo only"; \
	 echo "  make react-renderer   Start React renderer"; \
	 echo "  make html-renderer    Start HTML renderer"; \
	 echo "  make logs             Follow all logs"; \
	 echo "  make logs-<svc>       Follow one service (e.g. logs-registry, logs-graph)"; \
	 echo "  make rules-logs       Follow registry rules / action logs"; \
	 echo "  make form             Post sample FORM component"; \
	 echo "  make action FORM_ID=  Send SUBMIT action for given FORM component"; \
	 echo "  make rebuild-<svc>    Rebuild single service"; \
	 echo "  make restart-<svc>    Force recreate single service"; \
	 echo "  make ps               Show container status"; \
	 echo "  make clean            Stop and remove containers + volumes"; \
	 echo "  make prune            Prune dangling images"; \
	 echo "  make images           List project images"; \
	 echo "  make test             Run unit tests (registry rules engine)"; \
	 echo "  make contracts-build      Build @control-plane/contracts TypeScript package"; \
	 echo "  make contracts-typecheck  Type-check contracts without emitting output";

all: build up

build:
	$(DOCKER_COMPOSE) build

# Start registry only — use 'make stack' to add a daemon and renderer interactively
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
$(OTHER_SERVICES):
	$(DOCKER_COMPOSE) up -d $@

# Daemons also bring up the graph service (which transitively starts mongo
# via docker-compose depends_on). Either daemon serves the existing rules-engine
# flow on the registry, while the graph state-machine becomes available on :4100.
$(DAEMONS): graph
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

test:
	@echo "Running registry unit tests..."; \
	cd component-system/registry && npm test

clean:
	$(DOCKER_COMPOSE) down -v

prune:
	docker image prune -f

images:
	docker images | grep daemon || true

# =====================
# Contracts package
# =====================
contracts-install:
	cd contracts && npm install

contracts-build: contracts-install
	cd contracts && npm run build

contracts-typecheck: contracts-install
	cd contracts && npm run typecheck

contracts-clean:
	rm -rf contracts/dist contracts/node_modules

down:
	$(DOCKER_COMPOSE) down