using NUnit.Framework;

namespace DustGames.Minimal.Tests
{
    /// <summary>
    /// The smallest possible proof that the Editor can compile and run a test
    /// assembly: no scene, no engine state, just arithmetic.
    /// </summary>
    public class MinimalTests
    {
        [Test]
        public void TheExampleProjectCompilesAndRuns()
        {
            Assert.Pass("the minimal example project is alive");
        }

        [Test]
        public void ArithmeticStillWorks()
        {
            Assert.That(2 + 2, Is.EqualTo(4));
        }
    }
}
