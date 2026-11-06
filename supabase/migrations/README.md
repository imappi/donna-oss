Supabase CLI migrations are intentionally not used for Donna firm data.

The canonical migration tree is `db/migrations/`, applied with:

```bash
DATABASE_URL=postgres://... npm run db:migrate
```

Keep new firm-data migrations in `db/migrations/` only.
