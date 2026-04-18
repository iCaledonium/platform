defmodule Platform.Repo.Migrations.CreateAuthTokens do
  use Ecto.Migration

  def change do
    create table(:auth_tokens, primary_key: false) do
      add :id,         :string, primary_key: true, null: false
      add :user_id,    :string, null: false, references: :users, type: :string
      add :token_hash, :string, null: false
      # SHA256 of the raw bearer token — raw token is never stored
      add :expires_at, :naive_datetime_usec, null: false
      add :revoked_at, :naive_datetime_usec
      # null = still valid

      timestamps(type: :naive_datetime_usec)
    end

    create unique_index(:auth_tokens, [:token_hash])
    create index(:auth_tokens, [:user_id])
    create index(:auth_tokens, [:expires_at])
  end
end
