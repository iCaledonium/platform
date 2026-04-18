# Platform — Setup

## 1. Scaffold (run once on Mac Mini)

```bash
cd ~
mix phx.new platform --database sqlite3 --no-mailer
cd platform
git init
git remote add origin git@github.com:iCaledonium/platform.git
```

## 2. Add deps to mix.exs

Inside `deps` in `mix.exs`, add:

```elixir
{:nimble_totp, "~> 1.0"},
{:plug_crypto, "~> 2.0"},
```

Then:

```bash
mix deps.get
```

## 3. SCP migration files

From your local machine:

```bash
scp -i ~/.ssh/id_ed25519 ~/Downloads/migrations/*.exs \
  magnus@192.168.1.59:~/platform/priv/repo/migrations/
```

## 4. Configure SQLite path

In `config/dev.exs`, set the database path explicitly so it never
ends up inside the deliver_worlds directory:

```elixir
config :platform, Platform.Repo,
  database: Path.expand("~/platform/platform_dev.db"),
  pool_size: 5,
  pragma: [
    journal_mode: :wal,
    cache_size: -64_000,
    foreign_keys: 1,
    busy_timeout: 10_000
  ]
```

## 5. Create DB and migrate

```bash
cd ~/platform
mix ecto.create
mix ecto.migrate
```

## 6. systemd service (after app is ready to run)

```ini
# /etc/systemd/system/platform.service
[Unit]
Description=Anima Platform
After=network.target

[Service]
WorkingDirectory=/home/magnus/platform
ExecStart=/usr/local/bin/elixir --sname platform -S mix phx.server
Restart=on-failure
RestartSec=5
User=magnus
EnvironmentFile=/etc/systemd/system/platform.service.d/override.conf

[Install]
WantedBy=multi-user.target
```

## 7. Nginx route additions (in existing nginx config)

```nginx
location /login {
  proxy_pass http://localhost:5000;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
}

location /api/ {
  proxy_pass http://localhost:5000;
  proxy_set_header Host $host;
}
```
