# Use Rust latest
FROM rust:latest as builder

WORKDIR /usr/src/component-daemon
COPY . .

# Build the application
RUN cargo build --release

# Create a new stage with a minimal image
FROM debian:bullseye-slim

# Copy the binary from builder
COPY --from=builder /usr/src/component-daemon/target/release/component-daemon /usr/local/bin/component-daemon

# Expose the port the app runs on
EXPOSE 3001

# Run the binary
CMD ["component-daemon"]
