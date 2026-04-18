defmodule Platform.Repo.Migrations.CreateOrganizations do
  use Ecto.Migration

  def change do
    create table(:organizations, primary_key: false) do
      add :id,     :string, primary_key: true, null: false
      add :name,   :string, null: false
      add :slug,   :string, null: false
      # url-safe identifier e.g. "anima-systems"
      add :status, :string, null: false, default: "active"
      # active | suspended

      timestamps(type: :naive_datetime_usec)
    end

    create unique_index(:organizations, [:slug])
    create index(:organizations, [:status])
  end
end
