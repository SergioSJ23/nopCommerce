# nopCommerce + OpenTelemetry

**Flow instrumented:** Customer places an order — Basket → Order → Payment → Inventory


## Architecture Diagram

![Architecture Diagram](docs/imgs/architecture_diagram.png)

## How to Build and Run

### Prerequisites

- Docker and Docker Compose
- k6

### Start
On root of the repository, run:

```bash
docker compose up --build -d
```

| Service | URL |
|---------|-----|
| nopCommerce | http://localhost |
| Grafana | http://localhost:3000 (admin / admin) |
| Prometheus | http://localhost:9090 |
| Tempo | http://localhost:3200 |

### First-run setup

1. Open http://localhost and complete the installation wizard:
   - Server name: `nopcommerce_mssql_server`
   - Database name: `nopcommerce` (or leave default)
   - SQL Username: `sa`
   - SQL Password: `nopCommerce_db_password`
   - Create sample data: **checked**
   - Create database if it doesn't exist: **checked**
2. After "restart" (website just goes down):
    ```bash
    docker compose up
    ```

---

## View the Dashboard

Open http://localhost:3000 → Dashboards → **nopCommerce Checkout Flow**.

To generate traffic, run the load test:

```bash
k6 run load-tests/checkout.js
```
(it will take a minute for the first traces and metrics to appear in Grafana)
> Default: 10 human VUs + 10 bot VUs for 8 minutes (bots just appear after 1 min).
> Set `PRODUCT_ID` to a simple in-stock product from Admin → Catalog → Products.

```bash
k6 run load-tests/checkout.js -e PRODUCT_ID=3
```



