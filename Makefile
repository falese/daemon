.PHONY: all build up down stack logs

all: build up

build:
	docker-compose build

up:
	docker-compose up -d registry

# Interactive stack launcher
stack:
	@echo "Starting registry..."
	docker-compose up -d registry
	sleep 2
	@echo "Select daemon:"
	@echo "  1) Rust daemon"
	@echo "  2) Node daemon"
	@read -p "Enter choice [1-2]: " daemon_choice; \
	if [ "$$daemon_choice" = "1" ]; then \
		$(MAKE) rust-daemon; \
	elif [ "$$daemon_choice" = "2" ]; then \
		$(MAKE) node-daemon; \
	else \
		echo "Invalid daemon choice"; exit 1; \
	fi; \
	sleep 2; \
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
	fi

# Daemon and renderer targets
rust-daemon:
	docker-compose up -d rust-daemon

node-daemon:
	docker-compose up -d node-daemon

react-renderer:
	docker-compose up -d react-renderer

html-renderer:
	docker-compose up -d html-renderer

down:
	docker-compose down

logs:
	docker-compose logs -f