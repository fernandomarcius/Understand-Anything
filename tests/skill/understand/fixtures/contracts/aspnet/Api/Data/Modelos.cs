using System.ComponentModel.DataAnnotations.Schema;

namespace Loja.Api.Data;

[Table("Operacao", Schema = "dbo")]
public class Operacao { public int Id { get; set; } }

public class LogResumoConfiguration : IEntityTypeConfiguration<LogResumo>
{
    public void Configure(EntityTypeBuilder<LogResumo> builder) => builder.ToTable("LOG_RESUMO", "dbo");
}
