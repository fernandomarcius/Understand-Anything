using System.Reflection;
using Microsoft.AspNetCore.Mvc.ApplicationModels;

namespace Loja.Api.Fachada;

public static class PortadoNativo
{
    public const string Prefixo = "api/excel";
    public static readonly Assembly Assembly = typeof(PortadoContext).Assembly;

    internal sealed class RotasDoPortado : IApplicationModelConvention
    {
        public void Apply(ApplicationModel application)
        {
            foreach (var controller in application.Controllers.Where(c => c.ControllerType.Assembly == Assembly))
            {
                foreach (var acao in controller.Actions)
                foreach (var seletor in acao.Selectors)
                {
                    var combinada = AttributeRouteModel.CombineAttributeRouteModel(null, seletor.AttributeRouteModel);
                    seletor.AttributeRouteModel = new AttributeRouteModel
                    {
                        Template = "/" + Prefixo + "/" + (combinada?.Template ?? "").TrimStart('/'),
                    };
                }
            }
        }
    }
}
