defmodule Platform.Repo.Migrations.CreateUsers do
  use Ecto.Migration

  def change do
    create table(:users, primary_key: false) do
      add :id,        :string, primary_key: true, null: false
      add :name,      :string, null: false
      add :email,     :string, null: false
      add :status,    :string, null: false, default: "active"
      # active | suspended | deleted
      add :user_type, :string, null: false, default: "staff"
      # staff | organization_member | consumer | demo

      timestamps(type: :naive_datetime_usec)
    end

    create unique_index(:users, [:email])
    create index(:users, [:status])
    create index(:users, [:user_type])
  end
end
