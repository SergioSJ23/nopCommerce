# nopCommerce + OpenTelemetry

**Flow instrumented:** Customer places an order — Basket → Order → Payment → Inventory


## Architecture Diagram

![Architecture Diagram](docs/imgs/architecture_diagram.png)

## How to Build and Run

### Prerequisites

- Docker and Docker Compose
- k6

### Start

```bash
docker compose up --build -d
```

- **nopCommerce** → http://localhost
- **Grafana** → http://localhost:3000 (admin / admin)

### First-run setup

1. Open http://localhost and complete the installation wizard:
   - SQL Server host: `nopcommerce_mssql_server`
   - SA password: `nopCommerce_db_password`
2. Admin → Configuration → Payment Methods → **Manual Credit Card** → activate

---

## View the Dashboard

Open http://localhost:3000 → Dashboards → **nopCommerce Checkout Flow**.

To generate traffic, run the load test:

```bash
k6 run load-tests/checkout.js
```

> Default: 10 human VUs + 10 bot VUs for 8 minutes.
> Set `PRODUCT_ID` to a simple in-stock product from Admin → Catalog → Products.

```bash
k6 run load-tests/checkout.js -e PRODUCT_ID=3
```



