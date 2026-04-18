defmodule Platform.Repo.Migrations.CreateOrganizationMembers do
  use Ecto.Migration

  def change do
    create table(:organization_members, primary_key: false) do
      add :id,              :string, primary_key: true, null: false
      add :user_id,         :string, null: false, references: :users,        type: :string
      add :organization_id, :string, null: false, references: :organizations, type: :string
      add :role,            :string, null: false, default: "member"
      # owner | admin | builder | member

      timestamps(type: :naive_datetime_usec)
    end

    create unique_index(:organization_members, [:user_id, :organization_id])
    create index(:organization_members, [:organization_id])
    create index(:organization_members, [:user_id])
  end
end
