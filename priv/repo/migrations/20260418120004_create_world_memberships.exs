defmodule Platform.Repo.Migrations.CreateWorldMemberships do
  use Ecto.Migration

  def change do
    create table(:world_memberships, primary_key: false) do
      add :id,       :string, primary_key: true, null: false
      add :user_id,  :string, null: false, references: :users, type: :string
      add :world_id, :string, null: false
      # simulator world UUID — intentionally no FK, cross-db reference
      add :actor_id, :string, null: false
      # simulator actor UUID — intentionally no FK, cross-db reference
      add :role,     :string, null: false, default: "player"
      # owner | builder | player | viewer

      timestamps(type: :naive_datetime_usec)
    end

    # one user can hold multiple actors in the same world
    create unique_index(:world_memberships, [:user_id, :world_id, :actor_id])
    create index(:world_memberships, [:user_id])
    create index(:world_memberships, [:world_id])
  end
end
